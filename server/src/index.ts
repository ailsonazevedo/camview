import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyProxy from '@fastify/http-proxy';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { type Camera, type CameraInput, type Protocol, store, toPublic, validateInput } from './cameras.js';
import * as control from './control.js';
import { DvripError } from './dvrip.js';
import { discover, reachable } from './discover.js';
import * as go2rtc from './go2rtc.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');

const app = Fastify({ logger: { level: 'info' } });

await store.load();

// ---------- câmeras ----------

app.get('/api/cameras', async () => store.list().map(toPublic));

/** Lê modelo/recursos da câmera em segundo plano e guarda (ex.: tem PTZ?). */
function refreshDeviceInfo(cam: Camera) {
  control
    .readDeviceInfo(cam)
    .then((info) => store.update(cam.id, info))
    .catch((err) => app.log.warn({ host: cam.host, err: (err as Error).message }, 'não foi possível ler recursos via DVRIP'));
}

app.post('/api/cameras', async (req, reply) => {
  const { value, error } = validateInput(req.body);
  if (error) return reply.code(400).send({ error });
  const cam = await store.add(value as CameraInput);
  await go2rtc.syncCamera(cam).catch((err) => req.log.warn({ err }, 'falha ao registrar no go2rtc'));
  refreshDeviceInfo(cam);
  return reply.code(201).send(toPublic(cam));
});

app.put<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const { value, error } = validateInput(req.body, true);
  if (error) return reply.code(400).send({ error });
  // senha vazia na edição = manter a atual
  if (value!.password === '') delete value!.password;
  const connectionChanged = (['host', 'username', 'password', 'protocol', 'rtspPort', 'dvripPort', 'channel'] as const).some(
    (k) => value![k] !== undefined && value![k] !== cam[k],
  );
  const updated = (await store.update(cam.id, value!))!;
  if (connectionChanged) {
    control.closeSession(cam.id);
    await go2rtc.syncCamera(updated).catch((err) => req.log.warn({ err }, 'falha ao registrar no go2rtc'));
    refreshDeviceInfo(updated);
  }
  return toPublic(updated);
});

app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
  if (!(await store.remove(req.params.id))) return reply.code(404).send({ error: 'Câmera não encontrada' });
  control.closeSession(req.params.id);
  await go2rtc.removeCamera(req.params.id).catch(() => {});
  return reply.code(204).send();
});

app.put<{ Body: { ids: string[] } }>('/api/cameras/order', async (req, reply) => {
  if (!Array.isArray(req.body?.ids)) return reply.code(400).send({ error: 'ids é obrigatório' });
  await store.reorder(req.body.ids);
  return store.list().map(toPublic);
});

/**
 * Testa uma configuração antes de salvar: login DVRIP (controle/PTZ) e
 * vídeo pelo protocolo escolhido; se o vídeo falhar, tenta o outro protocolo.
 * Se vier `id` e a senha estiver vazia, usa a senha já salva.
 */
app.post<{ Body: Record<string, unknown> & { id?: string } }>('/api/cameras/test', async (req, reply) => {
  const { value, error } = validateInput({ name: 'teste', ...req.body });
  if (error) return reply.code(400).send({ error });
  const existing = req.body.id ? store.get(req.body.id) : undefined;
  if (existing && !req.body.password) value!.password = existing.password;
  const cam = { ...(value as CameraInput), ptzCalibration: null, id: `test_${Date.now()}`, ptz: null, createdAt: '' } satisfies Camera;

  if (!(await go2rtc.isUp())) {
    return { ok: false, error: 'go2rtc não está rodando. Inicie com "npm run dev".' };
  }
  const [rtspOpen, dvripOpen] = await Promise.all([reachable(cam.host, cam.rtspPort), reachable(cam.host, cam.dvripPort)]);
  if (!rtspOpen && !dvripOpen) {
    return { ok: false, error: `Nada respondeu em ${cam.host} (portas ${cam.rtspPort} e ${cam.dvripPort}). Confira o IP.` };
  }

  // Login DVRIP primeiro: dá a mensagem de erro mais clara para senha errada
  let device: control.DeviceInfo | undefined;
  if (dvripOpen) {
    try {
      device = await control.readDeviceInfo(cam);
    } catch (err) {
      const e = err as DvripError;
      if (e.ret !== undefined) return { ok: false, error: friendlyLoginError(e) };
    } finally {
      control.closeSession(cam.id);
    }
  }

  const order: Protocol[] = cam.protocol === 'rtsp' ? ['rtsp', 'dvrip'] : ['dvrip', 'rtsp'];
  let firstError: string | undefined;
  for (const protocol of order) {
    if (!(protocol === 'rtsp' ? rtspOpen : dvripOpen)) continue;
    // testa a HD: é a que costuma falhar (codec/resolução)
    const result = await go2rtc.probe({ ...cam, protocol }, 'hd');
    if (result.ok) {
      return { ...result, protocol, ptz: device?.ptz ?? null, model: device?.model };
    }
    firstError ??= result.error;
  }
  return { ok: false, error: firstError ?? 'Não foi possível abrir o vídeo.' };
});

function friendlyLoginError(err: DvripError) {
  if (err.ret === 206) return 'Conta bloqueada por excesso de tentativas. Aguarde alguns minutos (ou reinicie a câmera).';
  if (err.ret === 203 || err.ret === 204 || err.ret === 205) {
    return 'Usuário ou senha incorretos. Use o usuário e a senha do dispositivo definidos no app ICSee.';
  }
  return err.message;
}

/** Câmera alcançável na rede? (checagem TCP rápida, não abre vídeo) */
app.get('/api/cameras/status', async () => {
  const entries = await Promise.all(
    store.list().map(async (c) => [c.id, await reachable(c.host, c.protocol === 'rtsp' ? c.rtspPort : c.dvripPort)] as const),
  );
  return Object.fromEntries(entries);
});

/**
 * PTZ. Movimento contínuo: { command: 'DirectionLeft', action: 'start' } ao
 * apertar e { ..., action: 'stop' } ao soltar. Presets: { command: 'GotoPreset', preset: 1 }.
 */
app.post<{ Params: { id: string }; Body: { command?: unknown; action?: unknown; preset?: unknown; speed?: unknown } }>(
  '/api/cameras/:id/ptz',
  async (req, reply) => {
    const cam = store.get(req.params.id);
    if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
    const { command, action, preset, speed } = req.body ?? {};
    if (!control.isPtzCommand(command)) return reply.code(400).send({ error: 'Comando PTZ inválido' });
    if (action !== undefined && action !== 'start' && action !== 'stop' && action !== 'pulse') return reply.code(400).send({ error: 'Ação inválida' });
    const presetNum = preset === undefined ? undefined : Number(preset);
    if (presetNum !== undefined && (!Number.isInteger(presetNum) || presetNum < 1 || presetNum > 255)) {
      return reply.code(400).send({ error: 'Preset inválido' });
    }
    const speedNum = speed === undefined ? undefined : Number(speed);
    if (speedNum !== undefined && (!Number.isInteger(speedNum) || speedNum < 1 || speedNum > 8)) {
      return reply.code(400).send({ error: 'Velocidade inválida (1–8)' });
    }
    try {
      if (action === 'pulse') {
        const duration = Number((req.body as { durationMs?: unknown }).durationMs);
        if (!Number.isFinite(duration) || duration < 30 || duration > 6000 || command.endsWith('Preset')) {
          return reply.code(400).send({ error: 'Pulso inválido (30–6000 ms)' });
        }
        const elapsed = await control.ptzPulse(cam, command, Math.round(duration), speedNum);
        return { ok: true, elapsedMs: elapsed };
      }
      await control.ptz(cam, command, { action: action as 'start' | 'stop' | undefined, preset: presetNum, speed: speedNum });
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof DvripError && err.ret !== undefined ? friendlyLoginError(err) : (err as Error).message });
    }
  },
);

app.get('/api/discover', async () => {
  const known = new Set(store.list().map((c) => c.host));
  const devices = await discover();
  return devices.map((d) => ({ ...d, added: known.has(d.host) }));
});

app.get('/api/health', async () => ({ ok: true, go2rtc: await go2rtc.isUp() }));

// ---------- go2rtc (vídeo) ----------
// Expõe SÓ os endpoints de vídeo do player. O resto da API do go2rtc
// (/api/streams, /api/config...) mostra as senhas das câmeras e fica restrito
// ao localhost. Em dev o Vite faz o mesmo (web/vite.config.ts).
await app.register(fastifyProxy, {
  upstream: go2rtc.GO2RTC_URL,
  prefix: '/go2rtc/api/ws',
  rewritePrefix: '/api/ws',
  websocket: true,
});
await app.register(fastifyProxy, {
  upstream: go2rtc.GO2RTC_URL,
  prefix: '/go2rtc/api/hls', // fallback HLS (iPhone antigo)
  rewritePrefix: '/api/hls',
});

// ---------- front buildado (npm start) ----------
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

await app.listen({ port: PORT, host: HOST });

// Sincroniza as câmeras com o go2rtc assim que ele estiver de pé
// (no "npm run dev" os dois sobem juntos, então espera um pouco).
(async () => {
  for (let i = 0; i < 30; i++) {
    if (await go2rtc.isUp()) {
      try {
        await go2rtc.syncAll(store.list());
        app.log.info(`go2rtc sincronizado com ${store.list().length} câmera(s)`);
        for (const cam of store.list()) if (cam.ptz === null) refreshDeviceInfo(cam);
      } catch (err) {
        app.log.error({ err }, 'falha ao sincronizar com go2rtc');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  app.log.warn('go2rtc não respondeu em 30s — rode "npm run go2rtc"');
})();
