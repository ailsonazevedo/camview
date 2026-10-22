import type { FastifyBaseLogger } from 'fastify';
import { type Camera, type RelocationReason, store } from './cameras.js';
import { discover, type FoundDevice, normalizeMac, reachable, xmeyeBroadcast } from './discover.js';
import { DvripClient, MSG } from './dvrip.js';

/**
 * Reencontra câmeras que mudaram de IP (o roteador entrega IPs novos depois
 * de uma queda de energia). A câmera é reconhecida pela identidade estável
 * — série, MAC ou HostName — e, em último caso, fazendo login com as
 * credenciais dela nos aparelhos encontrados na rede.
 */

export interface RelocateCandidate {
  host: string;
  name?: string;
  model?: string;
  serial?: string;
  /** As credenciais da câmera funcionaram nesse IP. */
  loginOk?: boolean;
}

export interface RelocateResult {
  moved: { id: string; name: string; from: string; to: string; by: RelocationReason }[];
  unresolved: { id: string; name: string; candidates: RelocateCandidate[] }[];
  /** Quantas câmeras estavam fora do IP cadastrado. */
  missing: number;
}

interface LoginInfo {
  ok: boolean;
  serial?: string;
  model?: string;
  hostName?: string;
}

const FULL_SCAN_EVERY_MS = 10 * 60_000;
/** No modo automático não repete login recusado no mesmo IP (evita bloquear a conta por excesso de tentativas). */
const LOGIN_FAIL_TTL_MS = 30 * 60_000;

const videoPort = (c: Camera) => (c.protocol === 'rtsp' ? c.rtspPort : c.dvripPort);
const credKey = (c: Camera) => `${c.dvripPort}\n${c.username}\n${c.password}`;

async function tryLogin(host: string, cam: Camera): Promise<LoginInfo> {
  const client = new DvripClient({ host, port: cam.dvripPort, username: cam.username, password: cam.password, timeoutMs: 3000 });
  try {
    await client.connect();
    const info = (await client.command(MSG.SYSTEM_INFO, 'SystemInfo')).SystemInfo ?? {};
    return { ok: true, serial: info.SerialNo ? String(info.SerialNo) : undefined, model: info.HardWare };
  } catch {
    return { ok: false };
  } finally {
    client.close();
  }
}

export function createRelocator(deps: {
  log: FastifyBaseLogger;
  /** Aplica a troca de IP: salva e reconecta vídeo, gravação, eventos e PTZ. */
  move: (cam: Camera, host: string, by: RelocationReason, identity: Partial<Pick<Camera, 'serial' | 'mac' | 'hostName'>>) => Promise<void>;
}) {
  let running: Promise<RelocateResult> | null = null;
  let lastFullScan = 0;
  const loginFailures = new Map<string, number>();

  async function run(auto: boolean): Promise<RelocateResult> {
    const cameras = store.list();
    const online = new Map(await Promise.all(cameras.map(async (c) => [c.id, await reachable(c.host, videoPort(c))] as const)));
    let missing = cameras.filter((c) => !online.get(c.id));

    let devices = await xmeyeBroadcast().catch(() => [] as FoundDevice[]);

    const byHost = new Map(devices.map((d) => [d.host, d]));
    for (const c of cameras) {
      const there = online.get(c.id) && byHost.get(c.host);
      if (!there) continue;
      if (c.serial && there.serial && there.serial !== c.serial) {
        // IPs trocados entre duas câmeras cadastradas: o IP responde, mas é outra câmera.
        missing.push(c);
      } else if (there.serial === c.serial || !c.serial) {
        // completa a identidade de quem está no lugar (MAC só vem pelo broadcast)
        const patch: Partial<Camera> = {};
        if (there.serial && !c.serial) patch.serial = there.serial;
        if (there.mac && there.mac !== c.mac) patch.mac = there.mac;
        if (there.name && there.name !== c.hostName) patch.hostName = there.name;
        if (Object.keys(patch).length) await store.update(c.id, patch);
      }
    }
    if (missing.length === 0) return { moved: [], unresolved: [], missing: 0 };

    const missingIds = new Set(missing.map((c) => c.id));
    // IPs ocupados por câmeras que continuam no lugar não são candidatos
    const taken = new Set(cameras.filter((c) => !missingIds.has(c.id)).map((c) => c.host));
    const result: RelocateResult = { moved: [], unresolved: [], missing: missing.length };
    const used = new Set<string>();

    const apply = async (cam: Camera, dev: FoundDevice, by: RelocationReason, login?: LoginInfo) => {
      used.add(dev.host);
      missing = missing.filter((c) => c.id !== cam.id);
      const identity: Partial<Pick<Camera, 'serial' | 'mac' | 'hostName'>> = {};
      const serial = login?.serial ?? dev.serial;
      if (serial) identity.serial = serial;
      if (dev.mac) identity.mac = dev.mac;
      if (dev.name) identity.hostName = dev.name;
      const from = cam.host;
      if (from !== dev.host) {
        await deps.move(cam, dev.host, by, identity);
        result.moved.push({ id: cam.id, name: cam.name, from, to: dev.host, by });
        deps.log.info({ camera: cam.name, from, to: dev.host, by }, 'relocate: câmera reencontrada em outro IP');
      }
    };

    const matchByIdentity = async (list: FoundDevice[]) => {
      const free = () => list.filter((d) => !used.has(d.host) && !taken.has(d.host));
      for (const cam of [...missing]) {
        const dev = cam.serial && free().find((d) => d.serial === cam.serial);
        if (dev) await apply(cam, dev, 'serial');
      }
      for (const cam of [...missing]) {
        const mac = normalizeMac(cam.mac);
        const dev = mac && free().find((d) => normalizeMac(d.mac) === mac);
        if (dev) await apply(cam, dev, 'mac');
      }
      // câmeras cadastradas antes de guardarmos a série: o nome padrão é o HostName anunciado
      for (const cam of [...missing]) {
        if (cam.serial) continue;
        const names = [cam.hostName, cam.name].filter(Boolean) as string[];
        const hits = free().filter((d) => d.name && names.includes(d.name));
        const rivals = missing.filter((o) => o !== cam && !o.serial && [o.hostName, o.name].some((n) => n && hits.some((h) => h.name === n)));
        if (hits.length === 1 && rivals.length === 0) await apply(cam, hits[0], 'hostName');
      }
    };

    await matchByIdentity(devices);

    if (missing.length > 0 && (!auto || Date.now() - lastFullScan > FULL_SCAN_EVERY_MS)) {
      lastFullScan = Date.now();
      devices = await discover();
      await matchByIdentity(devices);
    }
    if (missing.length === 0) return result;

    // Último recurso: login com as credenciais de cada câmera nos aparelhos que sobraram
    const pending = devices.filter((d) => !used.has(d.host) && !taken.has(d.host));
    const logins = new Map<string, LoginInfo>(); // `${host}\n${credKey}`
    for (const cam of missing) {
      for (const dev of pending) {
        if (!dev.xmeye && !dev.ports.includes(cam.dvripPort)) continue;
        const key = `${dev.host}\n${credKey(cam)}`;
        if (logins.has(key)) continue;
        if (auto && Date.now() - (loginFailures.get(key) ?? 0) < LOGIN_FAIL_TTL_MS) continue;
        const info = await tryLogin(dev.host, cam);
        logins.set(key, info);
        if (info.ok) loginFailures.delete(key);
        else loginFailures.set(key, Date.now());
      }
    }
    const loginAt = (dev: FoundDevice, cam: Camera) => logins.get(`${dev.host}\n${credKey(cam)}`);

    for (const cam of [...missing]) {
      if (!cam.serial) continue;
      const dev = pending.find((d) => !used.has(d.host) && loginAt(d, cam)?.serial === cam.serial);
      if (dev) await apply(cam, dev, 'login', loginAt(dev, cam));
    }
    // sem série salva: só quando há um único aparelho do mesmo modelo que aceita a senha
    // (no automático não arrisca — fica para a pessoa confirmar)
    const knownSerials = new Set(cameras.map((c) => c.serial).filter(Boolean));
    const options = (cam: Camera) =>
      pending.filter((d) => {
        const l = loginAt(d, cam);
        return !used.has(d.host) && l?.ok && !(l.serial && knownSerials.has(l.serial)) && (!cam.model || !l.model || l.model === cam.model);
      });
    if (!auto) {
      for (const cam of [...missing]) {
        if (cam.serial) continue;
        const opts = options(cam);
        const rivals = missing.filter((o) => o !== cam && options(o).some((d) => opts.includes(d)));
        if (opts.length === 1 && rivals.length === 0) await apply(cam, opts[0], 'login', loginAt(opts[0], cam));
      }
    }

    const free = pending.filter((d) => !used.has(d.host));
    for (const cam of missing) {
      const candidates = free
        .map((d) => {
          const l = loginAt(d, cam);
          return { host: d.host, name: d.name, serial: l?.serial ?? d.serial, model: l?.model, loginOk: l?.ok } satisfies RelocateCandidate;
        })
        // quem aceita a senha (e não é outra câmera cadastrada) primeiro
        .filter((c) => !(c.serial && knownSerials.has(c.serial)))
        .sort((a, b) => Number(Boolean(b.loginOk)) - Number(Boolean(a.loginOk)));
      result.unresolved.push({ id: cam.id, name: cam.name, candidates });
    }
    if (result.unresolved.length > 0) {
      deps.log.warn({ cameras: result.unresolved.map((u) => u.name) }, 'relocate: câmera(s) fora do IP cadastrado e não reencontradas');
    }
    return result;
  }

  return {
    /** Uma busca por vez: chamadas simultâneas recebem o mesmo resultado. */
    relocate({ auto }: { auto: boolean }) {
      running ??= run(auto).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/**
 * Vigia: a cada minuto confere se as câmeras respondem; quem falhar em duas
 * verificações seguidas dispara uma busca (no máximo a cada 3 minutos).
 */
export function startWatcher(opts: { enabled: () => boolean; relocate: () => Promise<unknown>; log: FastifyBaseLogger }) {
  const CHECK_MS = 60_000;
  const MIN_GAP_MS = 3 * 60_000;
  const streak = new Map<string, number>();
  let lastRun = 0;
  let busy = false;

  const tick = async () => {
    if (busy || !opts.enabled()) return;
    busy = true;
    try {
      const cameras = store.list();
      let suspect = false;
      for (const c of cameras) {
        const ok = await reachable(c.host, videoPort(c));
        const n = ok ? 0 : (streak.get(c.id) ?? 0) + 1;
        streak.set(c.id, n);
        if (n >= 2) suspect = true;
      }
      for (const id of streak.keys()) if (!store.get(id)) streak.delete(id);
      if (suspect && Date.now() - lastRun >= MIN_GAP_MS) {
        lastRun = Date.now();
        await opts.relocate();
      }
    } catch (err) {
      opts.log.warn({ err: (err as Error).message }, 'relocate: falha na verificação automática');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
