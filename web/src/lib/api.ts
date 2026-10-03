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
  model?: string;
  createdAt: string;
  streams: { hd: string; sd: string; talk: string };
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
  health: () => request<{ ok: boolean; go2rtc: boolean }>('GET', '/api/health'),
  ptz: (id: string, body: { command: PtzCommand; action?: 'start' | 'stop' | 'pulse'; durationMs?: number; preset?: number; speed?: number }) =>
    request<{ ok: boolean }>('POST', `/api/cameras/${id}/ptz`, body),
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
