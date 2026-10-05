import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyProxy from '@fastify/http-proxy';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { type Camera, type CameraInput, type Protocol, store, toPublic, validateInput } from './cameras.js';
import * as control from './control.js';
import { DvripError } from './dvrip.js';
import { discover, reachable } from './discover.js';
import { type EventType, events } from './events.js';
import * as go2rtc from './go2rtc.js';
import * as media from './media.js';
import { recordings } from './recorder.js';
import * as location from './storage-location.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';
const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');

const app = Fastify({ logger: { level: 'info' } });

await store.load();
await media.loadSettings();
await location.initLocation();
if (!(await location.status()).available) {
  app.log.warn({ dir: media.mediaDir() }, 'local de armazenamento indisponível — nada será gravado até ele voltar');
}
recordings.init(app.log);
await events.init(app.log);

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
  recordings.applyContinuous(cam);
  events.apply(cam);
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
    recordings.restart(updated);
    events.restart(updated);
  } else {
    if (value!.recording) recordings.applyContinuous(updated);
    if (value!.events) events.apply(updated);
  }
  return toPublic(updated);
});

app.delete<{ Params: { id: string } }>('/api/cameras/:id', async (req, reply) => {
  if (!(await store.remove(req.params.id))) return reply.code(404).send({ error: 'Câmera não encontrada' });
  control.closeSession(req.params.id);
  recordings.remove(req.params.id);
  events.remove(req.params.id);
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
  const cam = { ...(value as CameraInput), ptzCalibration: null, presets: [], id: `test_${Date.now()}`, ptz: null, createdAt: '' } satisfies Camera;

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

/**
 * Posições salvas do PTZ. A posição em si é gravada na câmera (SetPreset por
 * número); o CamView guarda o nome e quais números estão em uso.
 */
app.post<{ Params: { id: string }; Body: { name?: unknown } }>('/api/cameras/:id/presets', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return reply.code(400).send({ error: 'Dê um nome à posição' });
  if (cam.presets.length >= 64) return reply.code(400).send({ error: 'Limite de posições atingido' });
  // menor número livre de 1 a 255
  const used = new Set(cam.presets.map((p) => p.number));
  let number = 1;
  while (used.has(number) && number < 255) number++;
  try {
    await control.ptz(cam, 'SetPreset', { preset: number });
  } catch (err) {
    return reply.code(502).send({ error: err instanceof DvripError && err.ret !== undefined ? friendlyLoginError(err) : (err as Error).message });
  }
  const preset = { number, name, createdAt: new Date().toISOString() };
  const updated = (await store.update(cam.id, { presets: [...cam.presets, preset] }))!;
  return reply.code(201).send({ preset, camera: toPublic(updated) });
});

app.post<{ Params: { id: string; number: string } }>('/api/cameras/:id/presets/:number/goto', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const number = Number(req.params.number);
  if (!cam.presets.some((p) => p.number === number)) return reply.code(404).send({ error: 'Posição não encontrada' });
  try {
    await control.ptz(cam, 'GotoPreset', { preset: number });
    return { ok: true };
  } catch (err) {
    return reply.code(502).send({ error: err instanceof DvripError && err.ret !== undefined ? friendlyLoginError(err) : (err as Error).message });
  }
});

app.delete<{ Params: { id: string; number: string } }>('/api/cameras/:id/presets/:number', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const number = Number(req.params.number);
  if (!cam.presets.some((p) => p.number === number)) return reply.code(404).send({ error: 'Posição não encontrada' });
  try {
    await control.ptz(cam, 'ClearPreset', { preset: number });
  } catch (err) {
    // mesmo se a câmera recusar o ClearPreset, removemos da lista do painel
    app.log.warn({ host: cam.host, err: (err as Error).message }, 'ClearPreset falhou; removendo só do painel');
  }
  const updated = (await store.update(cam.id, { presets: cam.presets.filter((p) => p.number !== number) }))!;
  return toPublic(updated);
});

/** Saúde da câmera (firmware, tempo ligado, série, sinal de Wi-Fi). */
app.get<{ Params: { id: string } }>('/api/cameras/:id/health', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  try {
    const health = await control.readHealth(cam);
    if (health.model && health.model !== cam.model) await store.update(cam.id, { model: health.model });
    return { online: true, ...health };
  } catch (err) {
    const e = err as DvripError;
    return { online: false, error: e.ret !== undefined ? friendlyLoginError(e) : e.message };
  }
});

app.get('/api/discover', async () => {
  const known = new Set(store.list().map((c) => c.host));
  const devices = await discover();
  return devices.map((d) => ({ ...d, added: known.has(d.host) }));
});

app.get('/api/health', async () => {
  const loc = await location.status();
  return { ok: true, go2rtc: await go2rtc.isUp(), media: { available: loc.available, dir: loc.dir, reason: loc.reason } };
});

// ---------- gravações ----------

app.get('/api/recordings/status', async () => recordings.status());

/** Gravação manual: { action: 'start', quality: 'hd' | 'sd' } ou { action: 'stop' }. */
app.post<{ Params: { id: string }; Body: { action?: unknown; quality?: unknown } }>('/api/cameras/:id/record', async (req, reply) => {
  const cam = store.get(req.params.id);
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const { action, quality } = req.body ?? {};
  if (action === 'start') {
    if (quality !== undefined && quality !== 'hd' && quality !== 'sd') return reply.code(400).send({ error: 'Qualidade inválida' });
    recordings.start(cam, 'manual', (quality as 'hd' | 'sd' | undefined) ?? 'hd');
  } else if (action === 'stop') {
    recordings.stop(cam);
  } else {
    return reply.code(400).send({ error: 'Ação inválida' });
  }
  return recordings.status();
});

app.get<{ Querystring: { camera?: string; date?: string } }>('/api/recordings', async (req) =>
  media.listRecordings(recordings.activePaths(), { cameraId: req.query.camera || undefined, date: req.query.date || undefined }),
);

app.get('/api/recordings/dates', async () => media.recordingDates());

// ---------- capturas ----------

app.addContentTypeParser('image/jpeg', { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));

app.post<{ Querystring: { camera?: string; lens?: string }; Body: Buffer }>('/api/captures', async (req, reply) => {
  const cam = req.query.camera ? store.get(req.query.camera) : undefined;
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Envie a imagem como image/jpeg' });
  try {
    return reply.code(201).send(await media.saveCapture(cam.id, req.query.lens ?? 'full', req.body));
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.get<{ Querystring: { camera?: string } }>('/api/captures', async (req) => media.listCaptures(req.query.camera || undefined));

/** Apaga uma gravação (não a que está sendo gravada) ou captura. */
app.delete<{ Querystring: { path?: string } }>('/api/media', async (req, reply) => {
  const rel = req.query.path;
  if (!rel || !/^(recordings|captures)\//.test(rel) || !media.isServableMedia(rel)) return reply.code(400).send({ error: 'Caminho inválido' });
  if (recordings.activePaths().has(rel)) return reply.code(409).send({ error: 'Essa gravação ainda está em andamento' });
  try {
    await media.deleteMedia(rel);
    return reply.code(204).send();
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- armazenamento ----------

app.get('/api/storage', async () => ({
  ...(await media.usage(recordings.activePaths())),
  settings: media.getSettings(),
  location: await location.status(),
}));

app.get('/api/settings', async () => media.getSettings());

app.put<{ Body: { retentionGB?: unknown; eventsDays?: unknown; detectionsEnabled?: unknown } }>('/api/settings', async (req, reply) => {
  const patch: Partial<media.Settings> = {};
  if (req.body?.retentionGB !== undefined) {
    const gb = Number(req.body.retentionGB);
    if (!Number.isFinite(gb) || gb < 1 || gb > 10_000) return reply.code(400).send({ error: 'Limite inválido (1–10000 GB)' });
    patch.retentionGB = gb;
  }
  if (req.body?.eventsDays !== undefined) {
    const days = Number(req.body.eventsDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return reply.code(400).send({ error: 'Dias inválidos (1–365)' });
    patch.eventsDays = days;
  }
  if (req.body?.detectionsEnabled !== undefined) {
    if (typeof req.body.detectionsEnabled !== 'boolean') return reply.code(400).send({ error: 'detectionsEnabled deve ser true ou false' });
    patch.detectionsEnabled = req.body.detectionsEnabled;
  }
  const saved = await media.saveSettings(patch);
  if (patch.detectionsEnabled !== undefined) {
    events.applyAll(store.list());
    app.log.info(`detecções ${patch.detectionsEnabled ? 'ligadas' : 'desligadas'} pelo painel`);
  }
  return saved;
});

// ---------- eventos (histórico de detecções) ----------

const EVENT_TYPES = new Set<EventType>(['human', 'motion', 'other']);

app.get<{ Querystring: { camera?: string; type?: string; date?: string; before?: string; limit?: string } }>('/api/events', async (req) => {
  const q = req.query;
  return events.list({
    cameraId: q.camera || undefined,
    type: EVENT_TYPES.has(q.type as EventType) ? (q.type as EventType) : undefined,
    date: q.date || undefined,
    before: q.before || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  });
});

app.get('/api/events/summary', async () => ({ enabled: media.getSettings().detectionsEnabled, unseen: events.unseenCount(), cameras: events.status() }));

app.post<{ Body: { ids?: unknown; all?: unknown } }>('/api/events/seen', async (req, reply) => {
  if (req.body?.all === true) events.markSeen('all');
  else if (Array.isArray(req.body?.ids) && req.body.ids.every((i) => typeof i === 'string')) events.markSeen(req.body.ids as string[]);
  else return reply.code(400).send({ error: 'Informe ids ou all' });
  return { unseen: events.unseenCount() };
});

app.delete<{ Body: { ids?: unknown } }>('/api/events', async (req, reply) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) return reply.code(400).send({ error: 'Informe ids' });
  const active = recordings.activePaths();
  const removed = await events.delete(ids as string[], (p) => active.has(p));
  return { removed };
});

/** Avisos em tempo real (Server-Sent Events): novos eventos e atualizações. */
app.get('/api/events/stream', (req, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const off = events.subscribe((msg) => res.write(`event: ${msg.kind}\ndata: ${JSON.stringify(msg.event)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.raw.on('close', () => {
    off();
    clearInterval(ping);
  });
});

/** Diagnóstico: últimos alarmes crus que chegaram das câmeras. */
app.get('/api/events/raw', async () => events.recentRaw);

/** Diagnóstico: simula um alarme (mesmo caminho de um real: foto + clipe). */
app.post<{ Body: { camera?: string; event?: string; seconds?: number } }>('/api/events/simulate', async (req, reply) => {
  const cam = req.body?.camera ? store.get(req.body.camera) : undefined;
  if (!cam) return reply.code(404).send({ error: 'Câmera não encontrada' });
  const seconds = Math.min(60, Math.max(1, Number(req.body?.seconds) || 5));
  if (!events.simulate(cam.id, req.body?.event || 'HumanDetect', seconds * 1000)) {
    const error = media.getSettings().detectionsEnabled ? 'O histórico está desligado para essa câmera' : 'As detecções estão desligadas em Configurações';
    return reply.code(409).send({ error });
  }
  return { ok: true };
});

// ---------- local de armazenamento ----------

app.get('/api/storage/location', async () => ({
  ...(await location.status()),
  move: location.currentMove(),
}));

app.get('/api/storage/suggestions', async () => location.suggestions());

/** Troca a pasta: { dir: '/Volumes/HD/CamView', move: true } */
app.put<{ Body: { dir?: unknown; move?: unknown } }>('/api/storage/location', async (req, reply) => {
  if (typeof req.body?.dir !== 'string') return reply.code(400).send({ error: 'Informe a pasta' });
  try {
    const result = await location.changeLocation(req.body.dir, {
      move: req.body.move === true,
      suspend: () => recordings.suspend(),
      resume: (token) => recordings.resume(token as ReturnType<typeof recordings.suspend>),
    });
    if (result.error) return reply.code(400).send({ error: result.error });
    app.log.info({ dir: result.status!.dir, move: req.body.move === true }, 'local de armazenamento alterado');
    return { ...result.status, move: location.currentMove() };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

// arquivos de mídia do local atual, com suporte a Range para o player de vídeo.
// Só arquivos no formato exato dos nossos — a pasta escolhida pode ter outras coisas.
await app.register(fastifyStatic, { root: media.DEFAULT_MEDIA_DIR, serve: false });
app.get<{ Params: { '*': string } }>('/media/*', (req, reply) => {
  const rel = req.params['*'];
  if (!media.isServableMedia(rel)) return reply.code(404).send({ error: 'Not found' });
  return reply.sendFile(rel, media.mediaDir());
});

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
  await app.register(fastifyStatic, { root: WEB_DIST, decorateReply: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html', WEB_DIST);
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
        for (const cam of store.list()) {
          if (cam.ptz === null) refreshDeviceInfo(cam);
          recordings.applyContinuous(cam);
          events.apply(cam);
        }
      } catch (err) {
        app.log.error({ err }, 'falha ao sincronizar com go2rtc');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  app.log.warn('go2rtc não respondeu em 30s — rode "npm run go2rtc"');
})();

// fecha os arquivos de gravação direito ao encerrar
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    recordings.stopAll();
    void events.stopAll().finally(() => app.close().finally(() => process.exit(0)));
  });
}
