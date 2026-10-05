import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Camera } from './cameras.js';
import { type AlarmInfo, DvripClient } from './dvrip.js';
import { DATA_DIR, getSettings, localDate, mediaDir, removeEmptyParents, stamp } from './media.js';
import { recordClip } from './recorder.js';
import { assertWritable } from './storage-location.js';

/**
 * Histórico de detecções, como no app ICSee: cada câmera mantém uma conexão
 * DVRIP inscrita nos alarmes (AlarmSet → AlarmInfo empurrado pela câmera).
 * Cada alarme vira um evento com foto (OPSNAP, da própria câmera) e, se
 * ligado, um clipe de vídeo gravado a partir do alarme.
 */

export type EventType = 'human' | 'motion' | 'other';

export interface CameraEvent {
  id: string;
  cameraId: string;
  type: EventType;
  /** Nome do alarme como a câmera manda (ex.: "VideoMotion", "HumanDetect"). */
  raw: string[];
  start: string;
  /** null enquanto o alarme está ativo. */
  end: string | null;
  snapshot: string | null;
  clip: string | null;
  seen: boolean;
}

const FILE = path.join(DATA_DIR, 'events.json');
/** Um alarme que chega até X ms depois do fim do anterior continua o mesmo evento. */
const MERGE_MS = 20_000;
/** Câmera não mandou "Stop": fecha sozinho. */
const AUTO_CLOSE_MS = 2 * 60_000;
/** O clipe continua um pouco depois do fim do alarme. */
const CLIP_TAIL_MS = 6_000;
const CLIP_MIN_MS = 15_000;
const CLIP_MAX_MS = 2 * 60_000;
const MAX_EVENTS = 20_000;
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];


/** Nome do alarme → tipo. Pessoa tem prioridade sobre movimento. */
export function classify(event: string): EventType {
  if (/human|person|ped|face|body/i.test(event)) return 'human';
  if (/motion|move/i.test(event)) return 'motion';
  return 'other';
}
const PRIORITY: Record<EventType, number> = { other: 0, motion: 1, human: 2 };

type Listener = (msg: { kind: 'new' | 'update'; event: CameraEvent }) => void;

interface Open {
  event: CameraEvent;
  /** Alarmes ainda ativos (por nome) — o evento fecha quando todos param. */
  active: Set<string>;
  closeTimer?: NodeJS.Timeout;
  autoClose?: NodeJS.Timeout;
  clip?: ReturnType<typeof recordClip>;
  clipStarted: number;
}

class EventStore {
  private events: CameraEvent[] = [];
  private saveTimer?: NodeJS.Timeout;
  private writing = Promise.resolve();

  async load() {
    try {
      this.events = JSON.parse(await readFile(FILE, 'utf8'));
    } catch {
      this.events = [];
    }
  }

  all() {
    return this.events;
  }

  add(e: CameraEvent) {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.scheduleSave();
  }

  get(id: string) {
    return this.events.find((e) => e.id === id);
  }

  changed() {
    this.scheduleSave();
  }

  remove(ids: Set<string>) {
    const removed = this.events.filter((e) => ids.has(e.id));
    this.events = this.events.filter((e) => !ids.has(e.id));
    this.scheduleSave();
    return removed;
  }

  /** Gravação agrupada (muitos alarmes seguidos = uma escrita). */
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 500);
  }

  save() {
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(`${FILE}.tmp`, JSON.stringify(this.events));
      await rename(`${FILE}.tmp`, FILE);
    });
    return this.writing;
  }
}

class CameraWatcher {
  private client?: DvripClient;
  private retryTimer?: NodeJS.Timeout;
  private retries = 0;
  private stopped = false;
  connected = false;
  lastError?: string;
  private open?: Open;

  constructor(
    public camera: Camera,
    private manager: EventManager,
    private log: FastifyBaseLogger,
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.client?.close();
    if (this.open) this.finish(this.open);
  }

  private async connect() {
    if (this.stopped) return;
    const c = this.camera;
    const client = new DvripClient({ host: c.host, port: c.dvripPort, username: c.username, password: c.password, timeoutMs: 8000 });
    this.client = client;
    client.onAlarm = (info) => this.onAlarm(info);
    client.onClosed = () => {
      this.connected = false;
      this.scheduleRetry('conexão encerrada');
    };
    try {
      await client.connect();
      await client.subscribeAlarms();
      this.connected = true;
      this.retries = 0;
      this.lastError = undefined;
      this.log.info({ camera: c.name }, 'ouvindo alarmes da câmera');
    } catch (err) {
      client.onClosed = undefined;
      client.close();
      this.scheduleRetry((err as Error).message);
    }
  }

  private scheduleRetry(reason: string) {
    if (this.stopped) return;
    this.lastError = reason;
    clearTimeout(this.retryTimer);
    const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }

  /** Tira a foto pela conexão de alarmes (já autenticada). */
  private async snapshot(event: CameraEvent) {
    try {
      await assertWritable();
      const jpeg = await this.client!.snapshot(this.camera.channel - 1);
      const rel = path.join('events', this.camera.id, localDate(new Date(event.start)), `${event.id}.jpg`);
      await mkdir(path.dirname(path.join(mediaDir(), rel)), { recursive: true });
      await writeFile(path.join(mediaDir(), rel), jpeg);
      event.snapshot = rel;
      this.manager.emit('update', event);
    } catch (err) {
      this.log.warn({ camera: this.camera.name, err: (err as Error).message }, 'foto do evento falhou');
    }
  }

  onAlarm(info: AlarmInfo) {
    const name = String(info.Event ?? 'Alarme');
    const starting = String(info.Status ?? 'Start').toLowerCase() !== 'stop';
    this.manager.debug(this.camera, info);
    if (starting) this.alarmStart(name);
    else this.alarmStop(name);
  }

  alarmStart(name: string) {
    const type = classify(name);
    const now = Date.now();
    const o = this.open;
    // continua o evento aberto (ou que acabou de fechar)
    if (o && (o.event.end === null || now - new Date(o.event.end).getTime() < MERGE_MS)) {
      clearTimeout(o.closeTimer);
      o.active.add(name);
      if (!o.event.raw.includes(name)) o.event.raw.push(name);
      if (PRIORITY[type] > PRIORITY[o.event.type]) o.event.type = type;
      o.event.end = null;
      this.armAutoClose(o);
      this.manager.emit('update', o.event);
      return;
    }
    if (o) this.finish(o);

    const start = new Date(now);
    const event: CameraEvent = {
      id: `${stamp(start)}_${this.camera.id}_${randomBytes(2).toString('hex')}`,
      cameraId: this.camera.id,
      type,
      raw: [name],
      start: start.toISOString(),
      end: null,
      snapshot: null,
      clip: null,
      seen: false,
    };
    const open: Open = { event, active: new Set([name]), clipStarted: now };
    this.open = open;
    if (this.camera.events.clip) {
      open.clip = recordClip(this.camera, 'hd', CLIP_MAX_MS, this.log);
      event.clip = open.clip.path;
      void open.clip.done.then((rel) => {
        event.clip = rel; // null se não gravou nada útil
        this.manager.emit('update', event);
      });
    }
    this.armAutoClose(open);
    this.manager.add(event);
    void this.snapshot(event);
  }

  alarmStop(name: string) {
    const o = this.open;
    if (!o) return;
    o.active.delete(name);
    if (o.active.size > 0) return;
    o.event.end = new Date().toISOString();
    this.manager.emit('update', o.event);
    // espera um pouco: se vier outro alarme logo, é o mesmo evento
    clearTimeout(o.closeTimer);
    o.closeTimer = setTimeout(() => this.finish(o), MERGE_MS);
    this.scheduleClipStop(o);
  }

  private armAutoClose(o: Open) {
    clearTimeout(o.autoClose);
    o.autoClose = setTimeout(() => {
      o.active.clear();
      if (o.event.end === null) o.event.end = new Date().toISOString();
      this.finish(o);
    }, AUTO_CLOSE_MS);
  }

  private scheduleClipStop(o: Open) {
    if (!o.clip) return;
    const elapsed = Date.now() - o.clipStarted;
    const wait = Math.max(CLIP_TAIL_MS, CLIP_MIN_MS - elapsed);
    const clip = o.clip;
    setTimeout(() => {
      if (o.event.end !== null) clip.stop(); // ninguém reabriu o evento nesse meio-tempo
    }, wait);
  }

  private finish(o: Open) {
    clearTimeout(o.closeTimer);
    clearTimeout(o.autoClose);
    if (o.event.end === null) o.event.end = new Date().toISOString();
    if (o.clip) {
      const elapsed = Date.now() - o.clipStarted;
      if (elapsed >= CLIP_MIN_MS) o.clip.stop();
      else setTimeout(() => o.clip!.stop(), CLIP_MIN_MS - elapsed);
    }
    if (this.open === o) this.open = undefined;
    this.manager.emit('update', o.event);
  }

  status() {
    return { connected: this.connected, error: this.lastError, active: Boolean(this.open && this.open.event.end === null) };
  }
}

class EventManager {
  readonly store = new EventStore();
  private watchers = new Map<string, CameraWatcher>();
  private listeners = new Set<Listener>();
  private log!: FastifyBaseLogger;
  /** Últimos alarmes crus recebidos (diagnóstico). */
  readonly recentRaw: { at: string; camera: string; info: AlarmInfo }[] = [];

  async init(log: FastifyBaseLogger) {
    this.log = log;
    await this.store.load();
    if (!getSettings().detectionsEnabled) log.warn('detecções desligadas nas configurações: nenhum evento será registrado');
    setInterval(() => void this.retention(), 60 * 60_000);
    void this.retention();
  }

  /** Liga/desliga o ouvinte conforme o cadastro da câmera. */
  apply(camera: Camera) {
    const current = this.watchers.get(camera.id);
    if (!getSettings().detectionsEnabled || !camera.events.enabled) {
      current?.stop();
      this.watchers.delete(camera.id);
      return;
    }
    if (current) return;
    const w = new CameraWatcher(camera, this, this.log);
    this.watchers.set(camera.id, w);
    w.start();
  }

  /** Chave geral (Configurações) mudou: liga/desliga o ouvinte de todas as câmeras. */
  applyAll(cameras: Camera[]) {
    for (const c of cameras) this.apply(c);
  }

  /** Dados de conexão mudaram: reconecta. */
  restart(camera: Camera) {
    this.watchers.get(camera.id)?.stop();
    this.watchers.delete(camera.id);
    this.apply(camera);
  }

  remove(cameraId: string) {
    this.watchers.get(cameraId)?.stop();
    this.watchers.delete(cameraId);
  }

  stopAll() {
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    return this.store.save();
  }

  status() {
    return Object.fromEntries([...this.watchers].map(([id, w]) => [id, w.status()]));
  }

  /** Simula um alarme (diagnóstico): passa pelo mesmo caminho de um alarme real. */
  simulate(cameraId: string, name: string, durationMs: number) {
    const w = this.watchers.get(cameraId);
    if (!w) return false;
    w.onAlarm({ Event: name, Status: 'Start', Channel: 0 });
    setTimeout(() => w.onAlarm({ Event: name, Status: 'Stop', Channel: 0 }), durationMs);
    return true;
  }

  debug(camera: Camera, info: AlarmInfo) {
    this.recentRaw.unshift({ at: new Date().toISOString(), camera: camera.name, info });
    this.recentRaw.length = Math.min(this.recentRaw.length, 50);
    this.log.info({ camera: camera.name, alarm: info }, 'alarme recebido');
  }

  add(event: CameraEvent) {
    this.store.add(event);
    this.emit('new', event);
  }

  emit(kind: 'new' | 'update', event: CameraEvent) {
    if (kind === 'update') this.store.changed();
    for (const l of this.listeners) l({ kind, event });
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  list(filter: { cameraId?: string; type?: EventType; date?: string; before?: string; limit?: number }) {
    const limit = Math.min(500, filter.limit ?? 100);
    const out: CameraEvent[] = [];
    const all = this.store.all();
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = all[i];
      if (filter.cameraId && e.cameraId !== filter.cameraId) continue;
      if (filter.type && e.type !== filter.type) continue;
      if (filter.date && localDate(new Date(e.start)) !== filter.date) continue;
      if (filter.before && e.start >= filter.before) continue;
      out.push(e);
    }
    return out;
  }

  unseenCount() {
    return this.store.all().filter((e) => !e.seen).length;
  }

  markSeen(ids: string[] | 'all') {
    for (const e of this.store.all()) if (ids === 'all' || ids.includes(e.id)) e.seen = true;
    this.store.changed();
  }

  async delete(ids: string[], isActiveClip: (p: string) => boolean) {
    const removed = this.store.remove(new Set(ids));
    for (const e of removed) {
      for (const rel of [e.snapshot, e.clip]) {
        if (!rel || isActiveClip(rel)) continue;
        const full = path.join(mediaDir(), rel);
        await rm(full, { force: true });
        await removeEmptyParents(full);
      }
    }
    return removed.length;
  }

  /** Apaga eventos (e fotos) mais velhos que o configurado. Os clipes seguem o limite de espaço das gravações. */
  private async retention() {
    const cutoff = new Date(Date.now() - getSettings().eventsDays * 864e5).toISOString();
    const old = this.store.all().filter((e) => e.start < cutoff);
    if (!old.length) return;
    for (const e of old) {
      if (!e.snapshot) continue;
      const full = path.join(mediaDir(), e.snapshot);
      await rm(full, { force: true });
      await removeEmptyParents(full);
    }
    this.store.remove(new Set(old.map((e) => e.id)));
    this.log.info({ removed: old.length }, 'eventos antigos apagados');
  }
}

export const events = new EventManager();
