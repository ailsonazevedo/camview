import type { Camera } from './cameras.js';
import { DvripClient, DvripError, MSG, PTZ_COMMANDS, type PtzCommand, ptzBody, RET_OK } from './dvrip.js';

/** Sessões DVRIP abertas por câmera (login é lento; PTZ precisa responder rápido). */
const sessions = new Map<string, { client: DvripClient; key: string; idle?: NodeJS.Timeout }>();
const IDLE_CLOSE_MS = 60_000;
/** Se o navegador nunca mandar "stop" (aba fechada, rede caiu), paramos sozinhos. */
const MAX_MOVE_MS = 8_000;
const moveWatchdogs = new Map<string, NodeJS.Timeout>();

const sessionKey = (cam: Camera) => `${cam.host}:${cam.dvripPort}:${cam.username}:${cam.password}`;

async function getClient(cam: Camera) {
  const key = sessionKey(cam);
  let entry = sessions.get(cam.id);
  if (entry && (entry.client.closed || entry.key !== key)) {
    entry.client.close();
    sessions.delete(cam.id);
    entry = undefined;
  }
  if (!entry) {
    const client = new DvripClient({ host: cam.host, port: cam.dvripPort, username: cam.username, password: cam.password });
    await client.connect();
    entry = { client, key };
    sessions.set(cam.id, entry);
  }
  clearTimeout(entry.idle);
  const current = entry;
  entry.idle = setTimeout(() => {
    current.client.close();
    if (sessions.get(cam.id) === current) sessions.delete(cam.id);
  }, IDLE_CLOSE_MS);
  return entry.client;
}

/** Executa com a sessão em cache; se ela caiu, reconecta uma vez. */
async function withClient<T>(cam: Camera, fn: (c: DvripClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient(cam));
  } catch (err) {
    if (err instanceof DvripError && err.ret !== undefined) throw err; // erro de login: não insiste
    closeSession(cam.id);
    return fn(await getClient(cam));
  }
}

export function closeSession(id: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  clearTimeout(entry.idle);
  entry.client.close();
  sessions.delete(id);
}

export function isPtzCommand(v: unknown): v is PtzCommand {
  return typeof v === 'string' && (PTZ_COMMANDS as readonly string[]).includes(v);
}

export async function ptz(
  cam: Camera,
  command: PtzCommand,
  opts: { action?: 'start' | 'stop'; preset?: number; speed?: number },
) {
  const channel = cam.channel - 1;
  const reply = await withClient(cam, (c) => c.command(MSG.PTZ, 'OPPTZControl', ptzBody(command, channel, opts)));
  if (!RET_OK.has(reply.Ret ?? 0)) throw new DvripError(`A câmera recusou o comando PTZ (Ret ${reply.Ret})`, reply.Ret);

  clearTimeout(moveWatchdogs.get(cam.id));
  moveWatchdogs.delete(cam.id);
  if (opts.action === 'start' && !command.endsWith('Preset')) {
    moveWatchdogs.set(
      cam.id,
      setTimeout(() => {
        moveWatchdogs.delete(cam.id);
        ptz(cam, command, { ...opts, action: 'stop' }).catch(() => {});
      }, MAX_MOVE_MS),
    );
  }
}

export interface DeviceInfo {
  ptz: boolean;
  model?: string;
  serial?: string;
  hostName?: string;
}

/**
 * Lê modelo, recursos (PTZ) e identidade (série/HostName) da câmera via DVRIP.
 * O MAC vem só do broadcast: pelo DVRIP alguns firmwares mandam um genérico (00:12:34:…).
 */
export async function readDeviceInfo(cam: Camera): Promise<DeviceInfo> {
  return withClient(cam, async (c) => {
    const info = await c.command(MSG.SYSTEM_INFO, 'SystemInfo');
    const abilities = await c.command(MSG.ABILITY_GET, 'SystemFunction');
    const other = abilities.SystemFunction?.OtherFunction ?? {};
    const ptz = Boolean(other.SupportPTZDirectionControl || other.SupportPTZTour);
    const out: DeviceInfo = { ptz, model: info.SystemInfo?.HardWare };
    if (info.SystemInfo?.SerialNo) out.serial = String(info.SystemInfo.SerialNo);
    try {
      const net = await c.command(MSG.CONFIG_GET, 'NetWork.NetCommon');
      const common = net['NetWork.NetCommon'] ?? net.NetWork?.NetCommon;
      if (common?.HostName) out.hostName = String(common.HostName);
    } catch {}
    return out;
  });
}

export interface CameraHealth {
  model?: string;
  /** Versão do firmware (SoftWareVersion). */
  firmware?: string;
  /** Data de compilação do firmware. */
  buildTime?: string;
  serial?: string;
  /** Tempo ligado, em segundos (quando a câmera informa). */
  uptimeSeconds?: number;
  /** Sinal do Wi-Fi em %, 0–100 (null = cabeada ou não informado). */
  wifiSignal?: number | null;
}

/** Converte o DeviceRunTime da XM (hex "0x..." ou número) em segundos. */
function parseRunTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const n = v.startsWith('0x') || v.startsWith('0X') ? Number.parseInt(v, 16) : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Normaliza o nível de Wi-Fi que a câmera manda (0–100 direto, ou 0–4 em barras). */
function parseWifi(cfg: Record<string, any> | undefined): number | null {
  if (!cfg) return null;
  const raw = cfg.SignalLevel ?? cfg.Signal ?? cfg.Intensity;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw <= 4) return Math.round((raw / 4) * 100); // em barras (0–4)
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Saúde da câmera: firmware, tempo ligado, série e sinal de Wi-Fi (via DVRIP). */
export async function readHealth(cam: Camera): Promise<CameraHealth> {
  return withClient(cam, async (c) => {
    const info = (await c.command(MSG.SYSTEM_INFO, 'SystemInfo')).SystemInfo ?? {};
    let wifiSignal: number | null = null;
    try {
      // Não suportado em câmera cabeada: ignora o erro e deixa null.
      const wifi = await c.command(MSG.CONFIG_GET, 'NetWork.Wifi');
      wifiSignal = parseWifi(wifi['NetWork.Wifi'] ?? wifi.NetWork?.Wifi);
    } catch {}
    return {
      model: info.HardWare,
      firmware: info.SoftWareVersion,
      buildTime: info.BuildTime,
      serial: info.SerialNo,
      uptimeSeconds: parseRunTime(info.DeviceRunTime),
      wifiSignal,
    };
  });
}

/**
 * Pulso de movimento com duração medida aqui no servidor (mais preciso que
 * start/stop pelo navegador) — usado pela mira por clique.
 */
export async function ptzPulse(cam: Camera, command: PtzCommand, durationMs: number, speed?: number) {
  await ptz(cam, command, { action: 'start', speed });
  const t0 = Date.now();
  try {
    await new Promise((r) => setTimeout(r, durationMs));
  } finally {
    await ptz(cam, command, { action: 'stop', speed });
  }
  return Date.now() - t0;
}
