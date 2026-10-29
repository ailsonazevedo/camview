import { Bell, Check, House, Loader2, Network, Pencil, Plus, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { inputCls } from '../components/CameraForm';
import { api, type Camera, type Home, type Settings as SettingsData } from '../lib/api';

interface Props {
  homes: Home[];
  /** Todas as câmeras (de todas as casas). */
  cameras: Camera[];
  onHomesChanged: () => void;
}

/** Configurações gerais do CamView. Cada grupo é uma seção; novas opções entram aqui. */
export function Settings({ homes, cameras, onHomesChanged }: Props) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState<keyof SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch((err) => setError((err as Error).message));
  }, []);

  const save = async <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => {
    setError(null);
    setSaving(key);
    try {
      const next = await api.saveSettings({ [key]: value });
      setSettings(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 lg:p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Configurações</h2>
        <p className="text-sm text-zinc-500">Opções gerais do CamView, valem para todas as câmeras.</p>
      </div>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      <Group icon={House} title="Casas">
        <Homes homes={homes} cameras={cameras} onChanged={onHomesChanged} />
      </Group>

      {settings === null ? (
        !error && <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      ) : (
        <>
          <Group icon={Bell} title="Detecções">
            <SwitchRow
              label="Registrar detecções"
              hint={
                settings.detectionsEnabled
                  ? 'As câmeras com histórico ligado no cadastro registram cada alarme (pessoa, movimento) com foto e, se configurado, um clipe de vídeo.'
                  : 'Desligado: nenhuma câmera registra eventos, fotos ou clipes de detecção. O histórico existente continua disponível em Eventos.'
              }
              checked={settings.detectionsEnabled}
              busy={saving === 'detectionsEnabled'}
              onChange={(v) => save('detectionsEnabled', v)}
            />
          </Group>
          <Group icon={Network} title="Rede">
            <SwitchRow
              label="Reencontrar câmeras que mudarem de IP"
              hint={
                settings.autoRelocate
                  ? 'Se uma câmera parar de responder no IP cadastrado (ex.: o roteador trocou o IP depois de uma queda de energia), o CamView procura por ela na rede pelo número de série e reconecta sozinho.'
                  : 'Desligado: quando o IP mudar, use “Reconectar câmeras” na aba Câmeras.'
              }
              checked={settings.autoRelocate}
              busy={saving === 'autoRelocate'}
              onChange={(v) => save('autoRelocate', v)}
            />
          </Group>
        </>
      )}
    </div>
  );
}

/** Locais com câmeras: o seletor do cabeçalho troca entre eles. */
function Homes({ homes, cameras, onChanged }: { homes: Home[]; cameras: Camera[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await fn();
      setEditing(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { id, name } = editing;
    run(id ?? 'new', () => (id ? api.renameHome(id, name) : api.createHome(name)));
  };

  const form = (
    <form onSubmit={save} className="flex items-center gap-2 p-3">
      <input
        className={inputCls}
        value={editing?.name ?? ''}
        onChange={(e) => setEditing((cur) => cur && { ...cur, name: e.target.value })}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}
        placeholder="Casa da praia"
        maxLength={60}
        required
        autoFocus
      />
      <button type="submit" disabled={busy !== null} title="Salvar" className="rounded-md bg-emerald-500 p-2 text-zinc-950 hover:bg-emerald-400 disabled:opacity-60">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </button>
      <button type="button" onClick={() => setEditing(null)} title="Cancelar" className="rounded-md p-2 text-zinc-400 hover:bg-white/5">
        <X className="h-4 w-4" />
      </button>
    </form>
  );

  return (
    <>
      {homes.map((h) => {
        if (editing?.id === h.id) return <div key={h.id}>{form}</div>;
        const count = cameras.filter((c) => c.homeId === h.id).length;
        const blocked = homes.length === 1 ? 'É preciso ter pelo menos uma casa' : count > 0 ? 'Mova ou remova as câmeras desta casa antes de excluí-la' : null;
        return (
          <div key={h.id} className="flex items-center gap-3 p-4">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-zinc-200">{h.name}</span>
              <span className="block text-[12px] text-zinc-500">
                {count} {count === 1 ? 'câmera' : 'câmeras'}
              </span>
            </span>
            <button onClick={() => setEditing({ id: h.id, name: h.name })} title="Renomear" className="rounded-md p-2 text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => run(h.id, () => api.deleteHome(h.id))}
              disabled={blocked !== null || busy !== null}
              title={blocked ?? 'Excluir'}
              className="rounded-md p-2 text-red-400/80 hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              {busy === h.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        );
      })}
      {editing?.id === null ? (
        form
      ) : (
        <button onClick={() => setEditing({ id: null, name: '' })} className="flex w-full items-center gap-2 p-4 text-left text-[13px] font-medium text-emerald-400 hover:bg-white/[0.02]">
          <Plus className="h-4 w-4" />
          Adicionar casa
        </button>
      )}
      {error && <div className="px-4 py-3 text-sm text-red-300">{error}</div>}
    </>
  );
}

function Group({ icon: Icon, title, children }: { icon: typeof Bell; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </h3>
      <div className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.02]">{children}</div>
    </section>
  );
}

function SwitchRow({ label, hint, checked, busy, onChange }: { label: string; hint: string; checked: boolean; busy: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-4 p-4">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-zinc-200">{label}</span>
        <span className="mt-0.5 block text-[12px] text-zinc-500">{hint}</span>
      </span>
      {busy && <Loader2 className="mt-1 h-4 w-4 animate-spin text-zinc-500" />}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={busy}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-60 ${checked ? 'bg-emerald-500' : 'bg-zinc-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </label>
  );
}
