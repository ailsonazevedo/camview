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
}

/** Lê modelo e recursos (PTZ) da câmera via DVRIP. */
export async function readDeviceInfo(cam: Camera): Promise<DeviceInfo> {
  return withClient(cam, async (c) => {
    const info = await c.command(MSG.SYSTEM_INFO, 'SystemInfo');
    const abilities = await c.command(MSG.ABILITY_GET, 'SystemFunction');
    const other = abilities.SystemFunction?.OtherFunction ?? {};
    const ptz = Boolean(other.SupportPTZDirectionControl || other.SupportPTZTour);
    return { ptz, model: info.SystemInfo?.HardWare };
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
