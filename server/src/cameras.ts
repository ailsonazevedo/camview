import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type Protocol = 'dvrip' | 'rtsp';
/** auto = detecta pelo formato do vídeo; dual = duas lentes empilhadas no mesmo quadro. */
export type Lenses = 'auto' | 'single' | 'dual';
export type LensPosition = 'top' | 'bottom';

export interface Camera {
  id: string;
  name: string;
  host: string;
  username: string;
  password: string;
  /** Protocolo usado para o vídeo. RTSP é o padrão (o DVRIP do go2rtc não entende alguns codecs). */
  protocol: Protocol;
  rtspPort: number;
  /** Porta DVRIP/XMeye — usada para PTZ e informações, mesmo com vídeo via RTSP. */
  dvripPort: number;
  /** Canal começando em 1 (câmeras avulsas sempre usam 1; NVR/DVR têm vários). */
  channel: number;
  lenses: Lenses;
  /** Em câmeras de duas lentes: qual metade do quadro é a lente móvel. */
  ptzLens: LensPosition;
  /** Nomes de cada lente (câmeras de duas lentes). */
  lensNames: { top: string; bottom: string };
  /** Detectado pela câmera (SystemFunction). null = ainda não verificado. */
  ptz: boolean | null;
  /** Calibração da mira (medida pelo navegador comparando imagens). */
  ptzCalibration: PtzCalibration | null;
  model?: string;
  createdAt: string;
}

export interface PtzCalibration {
  /** Velocidade (Step) usada na calibração e nos movimentos de mira. */
  speed: number;
  /** Fração da largura da imagem móvel percorrida por segundo de giro. */
  panRate: number;
  /** Fração da altura da imagem móvel percorrida por segundo de inclinação. */
  tiltRate: number;
  /** Deslocamento por segundo em cada comando (sinal = sentido); a câmera pode ser assimétrica. */
  rates?: { right: number; left: number; down: number; up: number };
  /** Largura que a imagem móvel ocupa dentro da fixa (0–1); null = não encontrada. */
  scale: number | null;
  updatedAt: string;
}

export type CameraInput = Omit<Camera, 'id' | 'createdAt' | 'ptz' | 'model' | 'ptzCalibration'> & {
  ptzCalibration?: PtzCalibration | null;
};

/**
 * Canal de áudio de volta (falar pela câmera): o go2rtc implementa o
 * intercomunicador DVRIP (OPTalk, G.711 em blocos de 320 bytes).
 */
export function talkSourceUrl(cam: SourceFields) {
  const user = encodeURIComponent(cam.username);
  const pass = encodeURIComponent(cam.password);
  return `dvrip://${user}:${pass}@${cam.host}:${cam.dvripPort}?channel=${cam.channel - 1}&backchannel=1`;
}

/** Versão enviada ao navegador: nunca expõe a senha. */
export type PublicCamera = Omit<Camera, 'password'> & {
  hasPassword: boolean;
  streams: { hd: string; sd: string; talk: string };
};

export const DEFAULT_PORTS: Record<Protocol, number> = { dvrip: 34567, rtsp: 554 };
const DEFAULT_LENS_NAMES = { top: 'Fixa', bottom: 'Móvel' };

const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const FILE = path.join(DATA_DIR, 'cameras.json');

export function streamNames(id: string) {
  return { hd: `${id}_hd`, sd: `${id}_sd`, talk: `${id}_talk` };
}

type SourceFields = Pick<Camera, 'host' | 'username' | 'password' | 'protocol' | 'rtspPort' | 'dvripPort' | 'channel'>;

/** URL de origem que o go2rtc usa para puxar o vídeo da câmera. */
export function sourceUrl(cam: SourceFields, quality: 'hd' | 'sd') {
  const user = encodeURIComponent(cam.username);
  const pass = encodeURIComponent(cam.password);
  if (cam.protocol === 'dvrip') {
    // DVRIP/Sofia (XMeye): canal começa em 0, subtype 0 = principal, 1 = extra
    const subtype = quality === 'hd' ? 0 : 1;
    return `dvrip://${user}:${pass}@${cam.host}:${cam.dvripPort}?channel=${cam.channel - 1}&subtype=${subtype}`;
  }
  // RTSP XiongMai: firmwares antigos leem as credenciais do path, os novos
  // exigem autenticação RTSP padrão — mandamos as duas.
  const stream = quality === 'hd' ? 0 : 1;
  return `rtsp://${user}:${pass}@${cam.host}:${cam.rtspPort}/user=${user}&password=${pass}&channel=${cam.channel}&stream=${stream}.sdp?real_stream`;
}

export function toPublic(cam: Camera): PublicCamera {
  const { password, ...rest } = cam;
  return { ...rest, hasPassword: password.length > 0, streams: streamNames(cam.id) };
}

function parsePort(v: unknown, field: string): number | string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const port = Number(v);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `${field} inválida`;
  return port;
}

export function validateInput(body: unknown, partial = false): { value?: Partial<CameraInput>; error?: string } {
  if (typeof body !== 'object' || body === null) return { error: 'Corpo inválido' };
  const b = body as Record<string, unknown>;
  const out: Partial<CameraInput> = {};

  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'Nome é obrigatório' };
    out.name = b.name.trim();
  }
  if (b.host !== undefined) {
    if (typeof b.host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(b.host.trim())) return { error: 'IP/host inválido' };
    out.host = b.host.trim();
  }
  if (b.protocol !== undefined) {
    if (b.protocol !== 'dvrip' && b.protocol !== 'rtsp') return { error: 'Protocolo inválido' };
    out.protocol = b.protocol;
  }
  for (const [key, label] of [
    ['rtspPort', 'Porta RTSP'],
    ['dvripPort', 'Porta DVRIP'],
  ] as const) {
    const port = parsePort(b[key], label);
    if (typeof port === 'string') return { error: port };
    if (port !== undefined) out[key] = port;
  }
  if (b.channel !== undefined && b.channel !== null && b.channel !== '') {
    const channel = Number(b.channel);
    if (!Number.isInteger(channel) || channel < 1 || channel > 64) return { error: 'Canal inválido' };
    out.channel = channel;
  }
  if (b.username !== undefined) {
    if (typeof b.username !== 'string') return { error: 'Usuário inválido' };
    out.username = b.username.trim();
  }
  if (b.password !== undefined) {
    if (typeof b.password !== 'string') return { error: 'Senha inválida' };
    out.password = b.password;
  }
  if (b.lenses !== undefined) {
    if (!['auto', 'single', 'dual'].includes(b.lenses as string)) return { error: 'Tipo de lente inválido' };
    out.lenses = b.lenses as Lenses;
  }
  if (b.ptzLens !== undefined) {
    if (b.ptzLens !== 'top' && b.ptzLens !== 'bottom') return { error: 'Lente móvel inválida' };
    out.ptzLens = b.ptzLens;
  }
  if (b.lensNames !== undefined) {
    const n = b.lensNames as Record<string, unknown>;
    if (typeof n !== 'object' || n === null || typeof n.top !== 'string' || typeof n.bottom !== 'string') {
      return { error: 'Nomes das lentes inválidos' };
    }
    out.lensNames = { top: n.top.trim() || DEFAULT_LENS_NAMES.top, bottom: n.bottom.trim() || DEFAULT_LENS_NAMES.bottom };
  }

  if (b.ptzCalibration !== undefined) {
    const c = b.ptzCalibration as Record<string, unknown> | null;
    if (c === null) {
      out.ptzCalibration = null;
    } else {
      const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
      // sinal negativo = câmera com movimento espelhado
      const rate = (v: unknown) => typeof v === 'number' && num(Math.abs(v), 0.001, 20);
      if (typeof c !== 'object' || !num(c.speed, 1, 8) || !rate(c.panRate) || !rate(c.tiltRate)) {
        return { error: 'Calibração inválida' };
      }
      if (c.scale !== null && !num(c.scale, 0.05, 1.5)) return { error: 'Calibração inválida' };
      const r = c.rates as Record<string, unknown> | undefined;
      if (r !== undefined && (typeof r !== 'object' || r === null || !['right', 'left', 'down', 'up'].every((k) => rate(r[k])))) {
        return { error: 'Calibração inválida' };
      }
      out.ptzCalibration = {
        speed: c.speed as number,
        panRate: c.panRate as number,
        tiltRate: c.tiltRate as number,
        ...(r && { rates: { right: r.right as number, left: r.left as number, down: r.down as number, up: r.up as number } }),
        scale: (c.scale as number | null) ?? null,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  if (!partial) {
    if (!out.name) return { error: 'Nome é obrigatório' };
    if (!out.host) return { error: 'IP/host é obrigatório' };
    out.protocol ??= 'rtsp';
    out.rtspPort ??= DEFAULT_PORTS.rtsp;
    out.dvripPort ??= DEFAULT_PORTS.dvrip;
    out.channel ??= 1;
    out.username ||= 'admin';
    out.password ??= '';
    out.lenses ??= 'auto';
    out.ptzLens ??= 'bottom';
    out.lensNames ??= { ...DEFAULT_LENS_NAMES };
  }
  return { value: out };
}

/** Converte cadastros da versão anterior (campo único `port`). */
function migrate(raw: Record<string, any>): Camera {
  const cam = { ...raw };
  if ('port' in cam) {
    const old = cam.port as number;
    if (cam.protocol === 'rtsp') {
      cam.rtspPort = old;
    } else {
      cam.dvripPort = old;
      // o DVRIP do go2rtc descarta alguns codecs H.264 dessas câmeras (ex.: 0x52) → vídeo via RTSP
      cam.protocol = 'rtsp';
    }
    delete cam.port;
  }
  cam.rtspPort ??= DEFAULT_PORTS.rtsp;
  cam.dvripPort ??= DEFAULT_PORTS.dvrip;
  cam.lenses ??= 'auto';
  cam.ptzLens ??= 'bottom';
  cam.lensNames ??= { ...DEFAULT_LENS_NAMES };
  cam.ptz ??= null;
  cam.ptzCalibration ??= null;
  return cam as Camera;
}

class CameraStore {
  private cameras: Camera[] = [];
  private writing = Promise.resolve();

  async load() {
    try {
      const raw = JSON.parse(await readFile(FILE, 'utf8')) as Record<string, any>[];
      this.cameras = raw.map(migrate);
      if (raw.some((c) => 'port' in c)) await this.save();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.cameras = [];
    }
  }

  list() {
    return this.cameras;
  }

  get(id: string) {
    return this.cameras.find((c) => c.id === id);
  }

  async add(input: CameraInput) {
    const cam: Camera = { ptzCalibration: null, ...input, ptz: null, id: `cam_${randomBytes(3).toString('hex')}`, createdAt: new Date().toISOString() };
    this.cameras.push(cam);
    await this.save();
    return cam;
  }

  async update(id: string, patch: Partial<Camera>) {
    const cam = this.get(id);
    if (!cam) return undefined;
    Object.assign(cam, patch);
    await this.save();
    return cam;
  }

  async remove(id: string) {
    const before = this.cameras.length;
    this.cameras = this.cameras.filter((c) => c.id !== id);
    if (this.cameras.length === before) return false;
    await this.save();
    return true;
  }

  async reorder(ids: string[]) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.cameras.sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
    await this.save();
  }

  /** Escrita atômica e serializada (evita JSON corrompido em gravações concorrentes). */
  private save() {
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(this.cameras, null, 2), { mode: 0o600 });
      await rename(tmp, FILE);
    });
    return this.writing;
  }
}

export const store = new CameraStore();
