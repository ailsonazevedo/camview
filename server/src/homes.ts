import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Local com um conjunto de câmeras (ex.: casa, sítio). O seletor do painel filtra por casa. */
export interface Home {
  id: string;
  name: string;
  createdAt: string;
}

const DATA_DIR = path.resolve(import.meta.dirname, '../../data');
const FILE = path.join(DATA_DIR, 'homes.json');
const DEFAULT_NAME = 'Minha casa';

export function validateHomeName(v: unknown): { value?: string; error?: string } {
  if (typeof v !== 'string' || !v.trim()) return { error: 'Nome é obrigatório' };
  if (v.trim().length > 60) return { error: 'Nome muito longo' };
  return { value: v.trim() };
}

class HomeStore {
  private homes: Home[] = [];
  private writing = Promise.resolve();

  /** Na primeira execução cria a casa padrão (as câmeras existentes vão para ela). */
  async load() {
    try {
      this.homes = JSON.parse(await readFile(FILE, 'utf8')) as Home[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.homes = [];
    }
    if (this.homes.length === 0) await this.add(DEFAULT_NAME);
  }

  list() {
    return this.homes;
  }

  get(id: string) {
    return this.homes.find((h) => h.id === id);
  }

  async add(name: string) {
    const home: Home = { id: `home_${randomBytes(3).toString('hex')}`, name, createdAt: new Date().toISOString() };
    this.homes.push(home);
    await this.save();
    return home;
  }

  async update(id: string, patch: Partial<Pick<Home, 'name'>>) {
    const home = this.get(id);
    if (!home) return undefined;
    Object.assign(home, patch);
    await this.save();
    return home;
  }

  async remove(id: string) {
    const before = this.homes.length;
    this.homes = this.homes.filter((h) => h.id !== id);
    if (this.homes.length === before) return false;
    await this.save();
    return true;
  }

  /** Escrita atômica e serializada (evita JSON corrompido em gravações concorrentes). */
  private save() {
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(this.homes, null, 2), { mode: 0o600 });
      await rename(tmp, FILE);
    });
    return this.writing;
  }
}

export const homes = new HomeStore();
