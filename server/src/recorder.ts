import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { Camera } from './cameras.js';
import { streamNames } from './cameras.js';
import { GO2RTC_URL } from './go2rtc.js';
import { enforceRetention, mediaDir, type RecordingKind, recordingPath } from './media.js';
import { assertWritable } from './storage-location.js';

/**
 * Gravação no computador: o go2rtc entrega a câmera como MP4 fragmentado
 * (vídeo H.264/H.265 + áudio G.711 convertido para FLAC, sem ffmpeg) e nós
 * salvamos direto no disco, em arquivos de alguns minutos.
 */

const SEGMENT_MS: Record<RecordingKind, number> = {
  continuous: 10 * 60_000,
  manual: 30 * 60_000,
  event: 3 * 60_000,
};
const RETRY_MS = [5_000, 10_000, 30_000, 60_000];
/** Arquivos menores que isso (câmera caiu logo no início) são descartados. */
const MIN_FILE_BYTES = 64 * 1024;

export interface RecordingStatus {
  kind: RecordingKind;
  quality: 'hd' | 'sd';
  startedAt: string;
  /** Arquivo sendo gravado agora (caminho relativo a data/media). */
  file: string | null;
  error?: string;
}

class Recorder {
  private abort?: AbortController;
  private rotateTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retries = 0;
  private stopped = false;
  currentFile: string | null = null;
  error?: string;
  readonly startedAt = new Date();

  constructor(
    public camera: Camera,
    public kind: RecordingKind,
    public quality: 'hd' | 'sd',
    private log: FastifyBaseLogger,
    private onSegmentDone: () => void,
  ) {}

  start() {
    this.stopped = false;
    void this.runSegment();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.rotateTimer);
    clearTimeout(this.retryTimer);
    this.abort?.abort();
  }

  status(): RecordingStatus {
    return { kind: this.kind, quality: this.quality, startedAt: this.startedAt.toISOString(), file: this.currentFile, error: this.error };
  }

  private async runSegment() {
    if (this.stopped) return;
    const rel = recordingPath(this.camera.id, new Date(), this.kind, this.quality);
    const full = path.join(mediaDir(), rel);
    const abort = new AbortController();
    this.abort = abort;

    // troca de arquivo a cada X minutos (a próxima parte começa logo em seguida)
    let rotated = false;
    this.rotateTimer = setTimeout(() => {
      rotated = true;
      abort.abort();
    }, SEGMENT_MS[this.kind]);

    try {
      await assertWritable(); // HD desconectado? não cria pastas no disco interno
      await mkdir(path.dirname(full), { recursive: true });
      const url = new URL('/api/stream.mp4', GO2RTC_URL);
      url.searchParams.set('src', streamNames(this.camera.id)[this.quality]);
      url.searchParams.set('mp4', 'flac'); // inclui o áudio da câmera (G.711 → FLAC)
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')).trim() || `go2rtc HTTP ${res.status}`);
      this.currentFile = rel;
      this.error = undefined;
      this.retries = 0;
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(full));
      // o go2rtc encerrou a stream sozinho (câmera caiu?)
      if (!this.stopped) throw new Error('A câmera parou de enviar vídeo');
    } catch (err) {
      const aborted = abort.signal.aborted;
      if (!aborted) {
        this.error = (err as Error).message;
        this.log.warn({ camera: this.camera.name, err: this.error }, 'gravação interrompida');
      }
    } finally {
      clearTimeout(this.rotateTimer);
      this.currentFile = null;
      await this.discardIfTiny(full);
      this.onSegmentDone();
    }

    if (this.stopped) return;
    if (rotated) {
      void this.runSegment();
    } else {
      // falhou: tenta de novo com espera crescente
      const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
      this.retryTimer = setTimeout(() => void this.runSegment(), wait);
    }
  }

  private async discardIfTiny(full: string) {
    const st = await stat(full).catch(() => null);
    if (st && st.size < MIN_FILE_BYTES) await rm(full, { force: true });
  }
}

class RecordingManager {
  private recorders = new Map<string, Recorder>();
  private log!: FastifyBaseLogger;
  private retentionTimer?: NodeJS.Timeout;

  init(log: FastifyBaseLogger) {
    this.log = log;
    this.retentionTimer = setInterval(() => void this.retention(), 5 * 60_000);
  }

  activePaths() {
    return new Set([...this.recorders.values()].map((r) => r.currentFile).filter((f): f is string => Boolean(f)));
  }

  status() {
    return Object.fromEntries([...this.recorders].map(([id, r]) => [id, r.status()]));
  }

  get(cameraId: string) {
    return this.recorders.get(cameraId);
  }

  start(camera: Camera, kind: RecordingKind, quality: 'hd' | 'sd') {
    const current = this.recorders.get(camera.id);
    // manual "por cima" da contínua: troca para a manual (na qualidade pedida)
    if (current && current.kind === kind && current.quality === quality) return current;
    current?.stop();
    const rec = new Recorder(camera, kind, quality, this.log, () => void this.retention());
    this.recorders.set(camera.id, rec);
    rec.start();
    this.log.info({ camera: camera.name, kind, quality }, 'gravação iniciada');
    return rec;
  }

  /** Para a gravação; se a câmera tem gravação contínua ligada, volta para ela. */
  stop(camera: Camera) {
    const current = this.recorders.get(camera.id);
    current?.stop();
    this.recorders.delete(camera.id);
    if (current) this.log.info({ camera: camera.name }, 'gravação parada');
    this.applyContinuous(camera);
  }

  /** Liga/desliga a contínua conforme o cadastro (sem atrapalhar uma manual em andamento). */
  applyContinuous(camera: Camera) {
    const current = this.recorders.get(camera.id);
    const want = camera.recording.continuous;
    if (current?.kind === 'manual') return;
    if (want && (!current || current.quality !== camera.recording.quality)) {
      this.start(camera, 'continuous', camera.recording.quality);
    } else if (!want && current) {
      current.stop();
      this.recorders.delete(camera.id);
    }
  }

  /** A câmera mudou (senha, IP...): reinicia a gravação com os dados novos. */
  restart(camera: Camera) {
    const current = this.recorders.get(camera.id);
    if (!current) return this.applyContinuous(camera);
    current.stop();
    this.recorders.delete(camera.id);
    this.start(camera, current.kind, current.quality);
  }

  remove(cameraId: string) {
    this.recorders.get(cameraId)?.stop();
    this.recorders.delete(cameraId);
  }

  /** Para tudo e devolve o que estava gravando (para retomar no local novo). */
  suspend() {
    const list = [...this.recorders.values()].map((r) => ({ camera: r.camera, kind: r.kind, quality: r.quality }));
    for (const r of this.recorders.values()) r.stop();
    this.recorders.clear();
    return list;
  }

  resume(list: { camera: Camera; kind: RecordingKind; quality: 'hd' | 'sd' }[]) {
    for (const r of list) this.start(r.camera, r.kind, r.quality);
  }

  stopAll() {
    for (const r of this.recorders.values()) r.stop();
    this.recorders.clear();
    clearInterval(this.retentionTimer);
  }

  private retentionRunning = false;
  private async retention() {
    if (this.retentionRunning) return;
    this.retentionRunning = true;
    try {
      const removed = await enforceRetention(this.activePaths());
      if (removed.length) this.log.info({ removed: removed.length }, 'gravações antigas apagadas (limite de espaço)');
    } catch (err) {
      this.log.warn({ err }, 'falha ao aplicar o limite de espaço');
    } finally {
      this.retentionRunning = false;
    }
  }
}

export const recordings = new RecordingManager();

/**
 * Clipe de evento: grava da câmera até `stop()` (ou o tempo máximo), em
 * paralelo a qualquer outra gravação. Devolve o caminho do arquivo.
 */
export function recordClip(camera: Camera, quality: 'hd' | 'sd', maxMs: number, log: FastifyBaseLogger) {
  const rel = recordingPath(camera.id, new Date(), 'event', quality);
  const full = path.join(mediaDir(), rel);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), maxMs);
  const done = (async () => {
    try {
      await assertWritable();
      await mkdir(path.dirname(full), { recursive: true });
      const url = new URL('/api/stream.mp4', GO2RTC_URL);
      url.searchParams.set('src', streamNames(camera.id)[quality]);
      url.searchParams.set('mp4', 'flac');
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`go2rtc HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(full));
    } catch (err) {
      if (!abort.signal.aborted) log.warn({ camera: camera.name, err: (err as Error).message }, 'clipe de evento falhou');
    } finally {
      clearTimeout(timer);
    }
    const st = await stat(full).catch(() => null);
    if (!st || st.size < MIN_FILE_BYTES) {
      await rm(full, { force: true });
      return null;
    }
    return rel;
  })();
  return {
    path: rel,
    /** Encerra o clipe (o arquivo fica completo: é MP4 fragmentado). */
    stop: () => abort.abort(),
    done,
  };
}
