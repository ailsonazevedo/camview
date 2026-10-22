import { Bell, Loader2, Network } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { api, type Settings as SettingsData } from '../lib/api';

/** Configurações gerais do CamView. Cada grupo é uma seção; novas opções entram aqui. */
export function Settings() {
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
