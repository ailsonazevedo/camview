import { randomBytes } from 'node:crypto';
import { type Camera, sourceUrl, streamNames, talkSourceUrl } from './cameras.js';

export const GO2RTC_URL = process.env.GO2RTC_URL ?? 'http://127.0.0.1:1984';

async function call(method: string, pathname: string, params: Record<string, string>, timeoutMs = 5000) {
  const url = new URL(pathname, GO2RTC_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `go2rtc ${method} ${pathname}: HTTP ${res.status}`);
  return text;
}

export async function isUp() {
  try {
    await call('GET', '/api', {}, 1500);
    return true;
  } catch {
    return false;
  }
}

export async function listStreams(): Promise<Record<string, unknown>> {
  return JSON.parse(await call('GET', '/api/streams', {}));
}

export async function putStream(name: string, src: string) {
  await call('PUT', '/api/streams', { name, src });
}

export async function deleteStream(name: string) {
  await call('DELETE', '/api/streams', { src: name });
}

/** Cria/atualiza as streams HD e SD de uma câmera no go2rtc. */
export async function syncCamera(cam: Camera) {
  const names = streamNames(cam.id);
  // DELETE + PUT garante que uma conexão antiga (com senha velha) seja descartada
  for (const q of ['hd', 'sd'] as const) {
    await deleteStream(names[q]).catch(() => {});
    await putStream(names[q], sourceUrl(cam, q));
  }
  await deleteStream(names.talk).catch(() => {});
  await putStream(names.talk, talkSourceUrl(cam));
}

export async function removeCamera(id: string) {
  const names = streamNames(id);
  await Promise.all(Object.values(names).map((n) => deleteStream(n)));
}

/** Deixa o go2rtc exatamente com as streams das câmeras cadastradas. */
export async function syncAll(cameras: Camera[]) {
  const existing = Object.keys(await listStreams());
  const wanted = new Set(cameras.flatMap((c) => Object.values(streamNames(c.id))));
  for (const name of existing) {
    if (!wanted.has(name)) await deleteStream(name).catch(() => {});
  }
  for (const cam of cameras) await syncCamera(cam);
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  codecs?: string[];
}

/**
 * Abre a câmera de verdade via go2rtc (stream temporária + probe) e
 * devolve os codecs encontrados — ou o erro da conexão.
 */
export async function probe(cam: Parameters<typeof sourceUrl>[0], quality: 'hd' | 'sd' = 'sd'): Promise<ProbeResult> {
  const name = `probe_${randomBytes(4).toString('hex')}`;
  try {
    await putStream(name, sourceUrl(cam, quality));
    const text = await call('GET', '/api/streams', { src: name, video: 'all', audio: 'all' }, 15000);
    const info = JSON.parse(text) as { producers?: { medias?: string[] }[] };
    const medias = info.producers?.flatMap((p) => p.medias ?? []) ?? [];
    if (medias.length === 0) return { ok: false, error: 'A câmera respondeu, mas sem trilhas de vídeo/áudio.' };
    return { ok: true, codecs: medias };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  } finally {
    await deleteStream(name).catch(() => {});
  }
}

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|aborted/i.test(msg)) return 'Tempo esgotado: a câmera não respondeu. Confira IP, porta e se está na mesma rede.';
  if (/refused/i.test(msg)) return 'Conexão recusada: a porta está fechada. Tente o outro protocolo (DVRIP 34567 / RTSP 554).';
  if (/no route|unreachable|EHOSTUNREACH/i.test(msg)) return 'Host inacessível: confira o IP da câmera.';
  // DVRIP: Ret 203 = senha incorreta, 205 = usuário inválido/login recusado, 206 = conta bloqueada
  if (/"Ret"\s*:\s*206/.test(msg)) return 'Conta bloqueada por excesso de tentativas. Aguarde alguns minutos (ou reinicie a câmera).';
  if (/password|auth|login|401|user\/pass|"Ret"\s*:\s*20[35]/i.test(msg)) {
    return 'Usuário ou senha incorretos. Use a senha do dispositivo definida no app ICSee (usuário normalmente "admin").';
  }
  return msg;
}
