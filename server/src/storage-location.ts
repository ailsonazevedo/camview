import { copyFile, mkdir, readdir, rename, rmdir, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, DEFAULT_MEDIA_DIR, getSettings, mediaDir, saveSettings, setMediaDir } from './media.js';

/**
 * Local configurável da mídia (gravações, capturas, fotos de eventos).
 *
 * Ordem de prioridade: variável CAMVIEW_MEDIA_DIR > configuração salva > padrão (data/media).
 *
 * Regra importante para HD externo: a pasta escolhida é criada só no momento
 * da configuração. Depois disso, se ela sumir (HD desconectado), o local fica
 * "indisponível" e nada é gravado — em vez de o macOS criar /Volumes/HD/...
 * no disco interno e a pessoa achar que está gravando no HD.
 */

const PROJECT_ROOT = path.resolve(DATA_DIR, '..');
const SUBDIRS = ['recordings', 'captures', 'events'];
const ENV_DIR = process.env.CAMVIEW_MEDIA_DIR?.trim() || null;

/** Pastas do sistema onde não faz sentido (nem é seguro) gravar. */
const FORBIDDEN_PREFIXES = ['/System', '/usr', '/bin', '/sbin', '/etc', '/private', '/dev', '/Library', '/Applications', '/opt', '/cores'];

export interface LocationStatus {
  dir: string;
  isDefault: boolean;
  defaultDir: string;
  /** Definido pela variável de ambiente: não dá para trocar pelo painel. */
  locked: boolean;
  available: boolean;
  reason?: string;
  freeBytes?: number;
  totalBytes?: number;
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

let available = false;
let unavailableReason: string | undefined;
let moveJob: MoveJob | null = null;

export function expandHome(p: string) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

async function isDir(p: string) {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

/** O local está pronto para gravar? (a pasta existe e aceita escrita) */
async function probe(dir: string) {
  if (!(await isDir(dir))) return 'A pasta não existe (HD desconectado ou pasta removida?)';
  const file = path.join(dir, `.camview-write-test-${process.pid}`);
  try {
    await writeFile(file, 'ok');
    await unlink(file);
    return null;
  } catch (err) {
    return `Sem permissão para gravar nessa pasta (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
}

/** Confere se a pasta escolhida é aceitável. Não cria nada. */
export async function validateTarget(input: string): Promise<{ dir?: string; error?: string }> {
  const raw = expandHome(input.trim());
  if (!raw) return { error: 'Informe uma pasta.' };
  if (!path.isAbsolute(raw)) return { error: 'Use o caminho completo da pasta (ex.: /Volumes/MeuHD/CamView ou ~/Movies/CamView).' };
  const dir = path.resolve(raw);
  if (dir === path.parse(dir).root) return { error: 'Escolha uma pasta, não a raiz do disco.' };
  if (FORBIDDEN_PREFIXES.some((p) => isInside(dir, p))) return { error: 'Essa é uma pasta do sistema. Escolha outra (ex.: em Filmes ou num HD externo).' };
  if (dir === os.homedir()) return { error: 'Escolha uma pasta dentro da sua pasta pessoal, não ela inteira (ex.: ~/Movies/CamView).' };
  // não pode conter o projeto (nem os dados com as senhas das câmeras)
  if (isInside(PROJECT_ROOT, dir) || isInside(DATA_DIR, dir)) return { error: 'A pasta não pode conter o projeto CamView.' };
  if (isInside(dir, DATA_DIR) && dir !== DEFAULT_MEDIA_DIR) return { error: 'Dentro da pasta de dados, só o local padrão é permitido.' };
  if (isInside(dir, PROJECT_ROOT) && !isInside(dir, DATA_DIR)) return { error: 'Escolha uma pasta fora do código do projeto.' };
  // HD externo: o disco precisa estar conectado
  const vol = /^\/Volumes\/[^/]+/.exec(dir)?.[0];
  if (vol && !(await isDir(vol))) return { error: `O disco ${vol} não está conectado.` };
  // só criamos a última pasta: a de cima precisa existir
  if (!(await isDir(path.dirname(dir)))) return { error: `A pasta ${path.dirname(dir)} não existe.` };
  if ((await stat(dir).catch(() => null))?.isFile()) return { error: 'Esse caminho é um arquivo, não uma pasta.' };
  return { dir };
}

/** Define o local na inicialização. Nunca cria pastas de um local personalizado que sumiu. */
export async function initLocation() {
  const configured = ENV_DIR ? path.resolve(expandHome(ENV_DIR)) : getSettings().mediaDir;
  const dir = configured ?? DEFAULT_MEDIA_DIR;
  setMediaDir(dir);
  if (dir === DEFAULT_MEDIA_DIR || ENV_DIR) await mkdir(dir, { recursive: true }).catch(() => {});
  await refreshAvailability();
}

export async function refreshAvailability() {
  const reason = await probe(mediaDir());
  available = reason === null;
  unavailableReason = reason ?? undefined;
  if (available) for (const sub of SUBDIRS) await mkdir(path.join(mediaDir(), sub), { recursive: true }).catch(() => {});
  return available;
}

/** Usado antes de gravar qualquer arquivo. Lança erro claro se o local sumiu. */
export async function assertWritable() {
  if (await isDir(mediaDir())) {
    if (!available) await refreshAvailability();
    if (available) return;
  } else {
    available = false;
    unavailableReason = 'A pasta não existe (HD desconectado ou pasta removida?)';
  }
  throw new Error(`Local de armazenamento indisponível: ${unavailableReason} — ${mediaDir()}`);
}

export async function status(): Promise<LocationStatus> {
  const dir = mediaDir();
  const st: LocationStatus = {
    dir,
    isDefault: dir === DEFAULT_MEDIA_DIR,
    defaultDir: DEFAULT_MEDIA_DIR,
    locked: Boolean(ENV_DIR),
    available,
    reason: unavailableReason,
  };
  if (available) {
    const fs = await statfs(dir).catch(() => null);
    if (fs) {
      st.freeBytes = fs.bavail * fs.bsize;
      st.totalBytes = fs.blocks * fs.bsize;
    }
  }
  return st;
}

/** Sugestões de pasta: padrão, Filmes e HDs externos conectados. */
export async function suggestions() {
  const out: { label: string; dir: string; freeBytes?: number }[] = [
    { label: 'Padrão (pasta do projeto)', dir: DEFAULT_MEDIA_DIR },
    { label: 'Filmes', dir: path.join(os.homedir(), 'Movies', 'CamView') },
  ];
  for (const v of await readdir('/Volumes', { withFileTypes: true }).catch(() => [])) {
    const vol = path.join('/Volumes', v.name);
    // "Macintosh HD" é um atalho para o disco interno (/)
    if (v.isSymbolicLink() || v.name.startsWith('.')) continue;
    const fs = await statfs(vol).catch(() => null);
    out.push({ label: `Disco "${v.name}"`, dir: path.join(vol, 'CamView'), freeBytes: fs ? fs.bavail * fs.bsize : undefined });
  }
  return out;
}

export function currentMove() {
  return moveJob;
}

/**
 * Troca o local. `suspend`/`resume` param e retomam as gravações em andamento
 * para que a próxima parte já saia no lugar novo.
 */
export async function changeLocation(
  input: string,
  opts: { move: boolean; suspend: () => unknown; resume: (token: unknown) => void },
): Promise<{ status?: LocationStatus; error?: string }> {
  if (ENV_DIR) return { error: 'O local está definido pela variável CAMVIEW_MEDIA_DIR; altere-a para trocar.' };
  if (moveJob?.state === 'running') return { error: 'Ainda estou movendo os arquivos para o local anterior. Aguarde terminar.' };
  const { dir, error } = await validateTarget(input);
  if (error || !dir) return { error };
  const from = mediaDir();
  if (dir === from) return { error: 'Esse já é o local atual.' };

  await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e;
  });
  const problem = await probe(dir);
  if (problem) return { error: problem };

  const token = opts.suspend();
  try {
    setMediaDir(dir);
    await saveSettings({ mediaDir: dir === DEFAULT_MEDIA_DIR ? null : dir });
    await refreshAvailability();
  } finally {
    opts.resume(token);
  }
  if (opts.move) void moveAll(from, dir);
  return { status: await status() };
}

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile() && !e.name.startsWith('.')) out.push(r);
  }
  return out;
}

async function moveFile(src: string, dst: string) {
  await mkdir(path.dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // outro disco: copia e apaga a original
    await copyFile(src, dst);
    await unlink(src);
  }
}

/** Move recordings/, captures/ e events/ do local antigo para o novo (em segundo plano). */
async function moveAll(from: string, to: string) {
  const files: { rel: string; size: number; mtime: number }[] = [];
  for (const sub of SUBDIRS) {
    for (const rel of await walk(path.join(from, sub))) {
      const st = await stat(path.join(from, sub, rel)).catch(() => null);
      if (st) files.push({ rel: path.join(sub, rel), size: st.size, mtime: st.mtimeMs });
    }
  }
  const job: MoveJob = {
    from,
    to,
    state: 'running',
    totalFiles: files.length,
    movedFiles: 0,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    movedBytes: 0,
    skipped: 0,
    startedAt: new Date().toISOString(),
  };
  moveJob = job;

  const pass = async (list: typeof files) => {
    const later: typeof files = [];
    for (const f of list) {
      const src = path.join(from, f.rel);
      const st = await stat(src).catch(() => null);
      if (!st) continue;
      // arquivo ainda sendo escrito (clipe de evento terminando): deixa para depois
      if (Date.now() - st.mtimeMs < 10_000) {
        later.push(f);
        continue;
      }
      let dst = path.join(to, f.rel);
      const existing = await stat(dst).catch(() => null);
      if (existing) {
        if (existing.size === st.size) {
          await unlink(src); // já copiado antes
          job.skipped++;
          job.movedFiles++;
          continue;
        }
        const ext = path.extname(dst);
        dst = `${dst.slice(0, -ext.length)}_movido${ext}`;
      }
      await moveFile(src, dst);
      await removeEmptyParentsUnder(src, from);
      job.movedFiles++;
      job.movedBytes += st.size;
    }
    return later;
  };

  try {
    let pending = await pass(files);
    // segunda (e terceira) volta para o que ainda estava sendo gravado
    for (let i = 0; i < 2 && pending.length; i++) {
      await new Promise((r) => setTimeout(r, 30_000));
      pending = await pass(pending);
    }
    job.skipped += pending.length;
    job.state = 'done';
  } catch (err) {
    job.state = 'error';
    job.error = (err as Error).message;
  }
  job.finishedAt = new Date().toISOString();
}

/** Limpa pastas vazias no local antigo (sem subir além dele). */
async function removeEmptyParentsUnder(file: string, root: string) {
  let dir = path.dirname(file);
  while (isInside(dir, root) && dir !== root && !SUBDIRS.some((s) => dir === path.join(root, s))) {
    try {
      await rmdir(dir); // só apaga se estiver vazia
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
