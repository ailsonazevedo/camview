export type Protocol = 'dvrip' | 'rtsp';
export type Lenses = 'auto' | 'single' | 'dual';
export type LensPosition = 'top' | 'bottom';

export interface Camera {
  id: string;
  name: string;
  host: string;
  username: string;
  hasPassword: boolean;
  protocol: Protocol;
  rtspPort: number;
  dvripPort: number;
  channel: number;
  lenses: Lenses;
  ptzLens: LensPosition;
  lensNames: { top: string; bottom: string };
  ptz: boolean | null;
  ptzCalibration: PtzCalibration | null;
  presets: CameraPreset[];
  recording: RecordingSettings;
  events: EventSettings;
  model?: string;
  createdAt: string;
  streams: { hd: string; sd: string; talk: string };
}

export interface CameraPreset {
  number: number;
  name: string;
  createdAt: string;
}

/** Saúde da câmera (GET /api/cameras/:id/health). */
export interface CameraHealth {
  online: boolean;
  error?: string;
  model?: string;
  firmware?: string;
  buildTime?: string;
  serial?: string;
  uptimeSeconds?: number;
  wifiSignal?: number | null;
}

export interface RecordingSettings {
  continuous: boolean;
  quality: 'hd' | 'sd';
}

export interface EventSettings {
  enabled: boolean;
  clip: boolean;
}

export type EventType = 'human' | 'motion' | 'other';

export interface CameraEvent {
  id: string;
  cameraId: string;
  type: EventType;
  raw: string[];
  start: string;
  end: string | null;
  snapshot: string | null;
  clip: string | null;
  seen: boolean;
}

export interface RecordingStatus {
  kind: 'manual' | 'continuous';
  quality: 'hd' | 'sd';
  startedAt: string;
  file: string | null;
  error?: string;
}

export interface RecordingFile {
  path: string;
  cameraId: string;
  kind: 'manual' | 'continuous' | 'event';
  quality: 'hd' | 'sd';
  start: string;
  end: string;
  bytes: number;
  active: boolean;
}

export interface CaptureFile {
  path: string;
  cameraId: string;
  lens: 'full' | 'top' | 'bottom';
  time: string;
  bytes: number;
}

export interface Settings {
  retentionGB: number;
  eventsDays: number;
  mediaDir: string | null;
  /** Chave geral: desligada, nenhuma câmera registra eventos. */
  detectionsEnabled: boolean;
}

export interface Storage {
  recordingsBytes: number;
  capturesBytes: number;
  limitBytes: number;
  settings: Settings;
  location: StorageLocation;
}

export interface StorageLocation {
  dir: string;
  isDefault: boolean;
  defaultDir: string;
  locked: boolean;
  available: boolean;
  reason?: string;
  freeBytes?: number;
  totalBytes?: number;
  move?: MoveJob | null;
}

export interface MoveJob {
  from: string;
  to: string;
  state: 'running' | 'done' | 'error';
  totalFiles: number;
  movedFiles: number;
  totalBytes: number;
  movedBytes: number;
  skipped: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Health {
  ok: boolean;
  go2rtc: boolean;
  media?: { available: boolean; dir: string; reason?: string };
}

export interface PtzCalibration {
  speed: number;
  /** Fração da largura percorrida por segundo (negativo = espelhado). */
  panRate: number;
  tiltRate: number;
  /** Deslocamento da imagem por segundo em cada comando (o sinal indica o sentido). */
  rates?: { right: number; left: number; down: number; up: number };
  /** Largura da imagem móvel dentro da fixa (0–1); null = não encontrada. */
  scale: number | null;
  updatedAt: string;
}

export interface CameraForm {
  name: string;
  host: string;
  username: string;
  password: string;
  protocol: Protocol;
  rtspPort: number | '';
  dvripPort: number | '';
  channel: number;
  lenses: Lenses;
  ptzLens: LensPosition;
  lensNames: { top: string; bottom: string };
  recording: RecordingSettings;
  events: EventSettings;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  codecs?: string[];
  protocol?: Protocol;
  ptz?: boolean | null;
  model?: string;
}

export interface FoundDevice {
  host: string;
  ports: number[];
  name?: string;
  serial?: string;
  xmeye: boolean;
  added: boolean;
}

export const PTZ_DIRECTIONS = [
  'DirectionLeftUp',
  'DirectionUp',
  'DirectionRightUp',
  'DirectionLeft',
  null,
  'DirectionRight',
  'DirectionLeftDown',
  'DirectionDown',
  'DirectionRightDown',
] as const;
export type PtzDirection = Exclude<(typeof PTZ_DIRECTIONS)[number], null>;
export type PtzCommand = PtzDirection | 'ZoomTile' | 'ZoomWide' | 'GotoPreset' | 'SetPreset';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data as T;
}

export const api = {
  list: () => request<Camera[]>('GET', '/api/cameras'),
  create: (form: CameraForm) => request<Camera>('POST', '/api/cameras', form),
  update: (id: string, form: Partial<CameraForm> & { ptzCalibration?: PtzCalibration | null }) => request<Camera>('PUT', `/api/cameras/${id}`, form),
  remove: (id: string) => request<void>('DELETE', `/api/cameras/${id}`),
  reorder: (ids: string[]) => request<Camera[]>('PUT', '/api/cameras/order', { ids }),
  test: (form: CameraForm & { id?: string }) => request<TestResult>('POST', '/api/cameras/test', form),
  status: () => request<Record<string, boolean>>('GET', '/api/cameras/status'),
  discover: () => request<FoundDevice[]>('GET', '/api/discover'),
  health: () => request<Health>('GET', '/api/health'),
  storageLocation: () => request<StorageLocation>('GET', '/api/storage/location'),
  storageSuggestions: () => request<{ label: string; dir: string; freeBytes?: number }[]>('GET', '/api/storage/suggestions'),
  setStorageLocation: (dir: string, move: boolean) => request<StorageLocation>('PUT', '/api/storage/location', { dir, move }),
  record: (id: string, action: 'start' | 'stop', quality?: 'hd' | 'sd') =>
    request<Record<string, RecordingStatus>>('POST', `/api/cameras/${id}/record`, { action, quality }),
  recordingStatus: () => request<Record<string, RecordingStatus>>('GET', '/api/recordings/status'),
  recordings: (filter: { camera?: string; date?: string } = {}) =>
    request<RecordingFile[]>('GET', `/api/recordings?${new URLSearchParams(filter as Record<string, string>)}`),
  recordingDates: () => request<string[]>('GET', '/api/recordings/dates'),
  captures: (camera?: string) => request<CaptureFile[]>('GET', `/api/captures${camera ? `?camera=${camera}` : ''}`),
  uploadCapture: async (camera: string, lens: string, jpeg: Blob) => {
    const res = await fetch(`/api/captures?camera=${encodeURIComponent(camera)}&lens=${lens}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
    return data as CaptureFile;
  },
  deleteMedia: (path: string) => request<void>('DELETE', `/api/media?path=${encodeURIComponent(path)}`),
  storage: () => request<Storage>('GET', '/api/storage'),
  settings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Omit<Settings, 'mediaDir'>>) => request<Settings>('PUT', '/api/settings', patch),
  events: (filter: { camera?: string; type?: string; date?: string; before?: string; limit?: number } = {}) =>
    request<CameraEvent[]>(
      'GET',
      `/api/events?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined && v !== '') as [string, string][])}`,
    ),
  eventsSummary: () =>
    request<{ enabled: boolean; unseen: number; cameras: Record<string, { connected: boolean; error?: string; active: boolean }> }>('GET', '/api/events/summary'),
  markSeen: (ids: string[] | 'all') => request<{ unseen: number }>('POST', '/api/events/seen', ids === 'all' ? { all: true } : { ids }),
  deleteEvents: (ids: string[]) => request<{ removed: number }>('DELETE', '/api/events', { ids }),
  ptz: (id: string, body: { command: PtzCommand; action?: 'start' | 'stop' | 'pulse'; durationMs?: number; preset?: number; speed?: number }) =>
    request<{ ok: boolean }>('POST', `/api/cameras/${id}/ptz`, body),
  savePreset: (id: string, name: string) => request<{ preset: CameraPreset; camera: Camera }>('POST', `/api/cameras/${id}/presets`, { name }),
  gotoPreset: (id: string, number: number) => request<{ ok: boolean }>('POST', `/api/cameras/${id}/presets/${number}/goto`),
  deletePreset: (id: string, number: number) => request<Camera>('DELETE', `/api/cameras/${id}/presets/${number}`),
  cameraHealth: (id: string) => request<CameraHealth>('GET', `/api/cameras/${id}/health`),
};

/** URL do WebSocket do go2rtc (relativa; o player converte para ws://). */
export const streamUrl = (name: string) => `/go2rtc/api/ws?src=${encodeURIComponent(name)}`;

// ---------- "views": cada lente vira um bloco no mosaico ----------

export type Crop = 'top' | 'bottom' | null;

export interface View {
  key: string;
  camera: Camera;
  crop: Crop;
  /** Nome exibido: "Rua" ou "Rua · Móvel" */
  label: string;
  lensLabel?: string;
  /** Esta view controla o PTZ? */
  ptz: boolean;
}

/** Proporção altura/largura acima da qual o quadro é tratado como 2 lentes empilhadas. */
export const DUAL_ASPECT_THRESHOLD = 0.9;

export function viewsOf(cam: Camera): View[] {
  if (cam.lenses !== 'dual') {
    return [{ key: cam.id, camera: cam, crop: null, label: cam.name, ptz: cam.ptz === true }];
  }
  return (['top', 'bottom'] as const).map((pos) => ({
    key: `${cam.id}:${pos}`,
    camera: cam,
    crop: pos,
    label: `${cam.name} · ${cam.lensNames[pos]}`,
    lensLabel: cam.lensNames[pos],
    ptz: cam.ptz === true && cam.ptzLens === pos,
  }));
}

/** URL pública de um arquivo de mídia (gravação ou captura). */
export const mediaUrl = (path: string) => `/media/${path.split('/').map(encodeURIComponent).join('/')}`;

export function formatBytes(n: number) {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
