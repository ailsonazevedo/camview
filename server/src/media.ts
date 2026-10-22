import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Arquivos de mídia (gravações, capturas e fotos de eventos) ficam numa pasta
 * configurável (padrão: data/media). Só arquivos com o formato dos nossos são
 * servidos por HTTP (isServableMedia) — nunca data/cameras.json ou outros.
 */
export const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
/** Local padrão: data/media dentro do projeto. Configurável (ver storage-location.ts). */
export const DEFAULT_MEDIA_DIR = path.join(DATA_DIR, 'media');
let mediaRoot = DEFAULT_MEDIA_DIR;

/** Pasta raiz atual das gravações, capturas e fotos de eventos. */
export const mediaDir = () => mediaRoot;
export const recordingsDir = () => path.join(mediaRoot, 'recordings');
export const capturesDir = () => path.join(mediaRoot, 'captures');
export const eventsDir = () => path.join(mediaRoot, 'events');

export function setMediaDir(dir: string) {
  mediaRoot = path.resolve(dir);
}
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---------- configurações ----------

export interface Settings {
  /** Espaço máximo para gravações; as mais antigas são apagadas ao passar disso. */
  retentionGB: number;
  /** Por quantos dias o histórico de eventos (e as fotos deles) é mantido. */
  eventsDays: number;
  /** Pasta escolhida para a mídia (null = padrão, data/media). */
  mediaDir: string | null;
  /** Chave geral das detecções: desligada, nenhuma câmera registra eventos. */
  detectionsEnabled: boolean;
  /** Reencontrar sozinho, na rede, as câmeras que mudarem de IP (ex.: depois de queda de energia). */
  autoRelocate: boolean;
}

const DEFAULT_SETTINGS: Settings = { retentionGB: 20, eventsDays: 30, mediaDir: null, detectionsEnabled: true, autoRelocate: true };
let settings: Settings = { ...DEFAULT_SETTINGS };

export async function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

export function getSettings() {
  return settings;
}

export async function saveSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(`${SETTINGS_FILE}.tmp`, JSON.stringify(settings, null, 2));
  await rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE);
  return settings;
}

// ---------- nomes de arquivo ----------

const pad = (n: number) => String(n).padStart(2, '0');

/** 2026-10-03 */
export function localDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 20261003-143005 (hora local — é o que a pessoa procura na lista) */
export function stamp(d: Date) {
  return `${localDate(d).replaceAll('-', '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseStamp(s: string) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, se);
}

const SAFE_ID = /^[a-z0-9_]+$/i;

/** Formatos exatos dos arquivos que o CamView cria — os únicos servidos por /media. */
const SERVABLE = [
  /^recordings\/[a-z0-9_]+\/\d{4}-\d{2}-\d{2}\/\d{8}-\d{6}_(manual|continuous|event)_(hd|sd)\.mp4$/i,
  /^captures\/[a-z0-9_]+\/\d{8}-\d{9}_(full|top|bottom)\.jpg$/i,
  /^events\/[a-z0-9_]+\/\d{4}-\d{2}-\d{2}\/\d{8}-\d{6}_[a-z0-9_]+_[0-9a-f]{4}\.jpg$/i,
];

export function isServableMedia(rel: string) {
  return SERVABLE.some((re) => re.test(rel));
}

/** Caminho relativo seguro dentro de data/media (bloqueia "../" e afins). */
export function resolveMedia(rel: string) {
  const full = path.resolve(mediaDir(), rel);
  if (!full.startsWith(mediaDir() + path.sep)) throw new Error('Caminho inválido');
  return full;
}

// ---------- gravações ----------

export type RecordingKind = 'manual' | 'continuous' | 'event';

export interface RecordingFile {
  /** Caminho relativo a data/media (também é a URL: /media/<path>). */
  path: string;
  cameraId: string;
  kind: RecordingKind;
  quality: 'hd' | 'sd';
  start: string;
  end: string;
  bytes: number;
  active: boolean;
}

export function recordingPath(cameraId: string, start: Date, kind: RecordingKind, quality: 'hd' | 'sd') {
  if (!SAFE_ID.test(cameraId)) throw new Error('Câmera inválida');
  return path.join('recordings', cameraId, localDate(start), `${stamp(start)}_${kind}_${quality}.mp4`);
}

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function listRecordings(activePaths: Set<string>, filter: { cameraId?: string; date?: string } = {}) {
  const out: RecordingFile[] = [];
  for (const camDir of await listDir(recordingsDir())) {
    if (!camDir.isDirectory() || (filter.cameraId && camDir.name !== filter.cameraId)) continue;
    for (const dayDir of await listDir(path.join(recordingsDir(), camDir.name))) {
      if (!dayDir.isDirectory() || (filter.date && dayDir.name !== filter.date)) continue;
      for (const f of await listDir(path.join(recordingsDir(), camDir.name, dayDir.name))) {
        const m = /^(\d{8}-\d{6})_(manual|continuous|event)_(hd|sd)\.mp4$/.exec(f.name);
        if (!f.isFile() || !m) continue;
        const rel = path.join('recordings', camDir.name, dayDir.name, f.name);
        const st = await stat(path.join(mediaDir(), rel)).catch(() => null);
        const start = parseStamp(m[1]);
        if (!st || !start) continue;
        const active = activePaths.has(rel);
        out.push({
          path: rel,
          cameraId: camDir.name,
          kind: m[2] as RecordingKind,
          quality: m[3] as 'hd' | 'sd',
          start: start.toISOString(),
          end: (active ? new Date() : st.mtime).toISOString(),
          bytes: st.size,
          active,
        });
      }
    }
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

/** Datas (YYYY-MM-DD) que têm gravações, mais recentes primeiro. */
export async function recordingDates() {
  const dates = new Set<string>();
  for (const camDir of await listDir(recordingsDir())) {
    if (!camDir.isDirectory()) continue;
    for (const d of await listDir(path.join(recordingsDir(), camDir.name))) if (d.isDirectory()) dates.add(d.name);
  }
  return [...dates].sort().reverse();
}

export async function deleteMedia(rel: string) {
  const full = resolveMedia(rel);
  await rm(full, { force: true });
  await removeEmptyParents(full);
}

/** Remove pastas que ficaram vazias (dia sem vídeos), sem sair de data/media. */
export async function removeEmptyParents(file: string) {
  let dir = path.dirname(file);
  while (dir.startsWith(mediaDir() + path.sep) && dir !== recordingsDir() && dir !== capturesDir() && dir !== eventsDir()) {
    try {
      await rmdir(dir); // só funciona se estiver vazia
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Apaga as gravações mais antigas até caber no limite (não mexe nas ativas). */
export async function enforceRetention(activePaths: Set<string>) {
  const limit = settings.retentionGB * 1024 ** 3;
  const all = await listRecordings(activePaths);
  let total = all.reduce((s, r) => s + r.bytes, 0);
  const removed: string[] = [];
  for (const r of [...all].reverse()) {
    if (total <= limit) break;
    if (r.active) continue;
    await rm(path.join(mediaDir(), r.path), { force: true });
    await removeEmptyParents(path.join(mediaDir(), r.path));
    total -= r.bytes;
    removed.push(r.path);
  }
  return removed;
}

// ---------- capturas ----------

export interface CaptureFile {
  path: string;
  cameraId: string;
  lens: string;
  time: string;
  bytes: number;
}

export async function saveCapture(cameraId: string, lens: string, jpeg: Buffer) {
  if (!SAFE_ID.test(cameraId) || !/^(full|top|bottom)$/.test(lens)) throw new Error('Parâmetros inválidos');
  // checa a assinatura JPEG (FF D8 FF) — não aceitamos outros arquivos
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error('A imagem não é um JPEG');
  const { assertWritable } = await import('./storage-location.js');
  await assertWritable();
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const rel = path.join('captures', cameraId, `${stamp(now)}${ms}_${lens}.jpg`);
  await mkdir(path.dirname(path.join(mediaDir(), rel)), { recursive: true });
  await writeFile(path.join(mediaDir(), rel), jpeg);
  return { path: rel, cameraId, lens, time: now.toISOString(), bytes: jpeg.length } satisfies CaptureFile;
}

export async function listCaptures(cameraId?: string) {
  const out: CaptureFile[] = [];
  for (const camDir of await listDir(capturesDir())) {
    if (!camDir.isDirectory() || (cameraId && camDir.name !== cameraId)) continue;
    for (const f of await listDir(path.join(capturesDir(), camDir.name))) {
      const m = /^(\d{8}-\d{6})\d{3}_(full|top|bottom)\.jpg$/.exec(f.name);
      if (!f.isFile() || !m) continue;
      const rel = path.join('captures', camDir.name, f.name);
      const st = await stat(path.join(mediaDir(), rel)).catch(() => null);
      const time = parseStamp(m[1]);
      if (!st || !time) continue;
      out.push({ path: rel, cameraId: camDir.name, lens: m[2], time: time.toISOString(), bytes: st.size });
    }
  }
  // nome do arquivo = data/hora com milissegundos → ordena do mais novo para o mais antigo
  return out.sort((a, b) => path.basename(b.path).localeCompare(path.basename(a.path)));
}

/** Espaço usado por gravações e capturas. */
export async function usage(activePaths: Set<string>) {
  const recs = await listRecordings(activePaths);
  const caps = await listCaptures();
  return {
    recordingsBytes: recs.reduce((s, r) => s + r.bytes, 0),
    capturesBytes: caps.reduce((s, c) => s + c.bytes, 0),
    limitBytes: settings.retentionGB * 1024 ** 3,
  };
}
