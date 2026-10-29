import { CheckCircle2, ChevronDown, Loader2, Plug, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api, type Camera, type CameraForm as Form, type Home, type Lenses, type TestResult } from '../lib/api';

interface Props {
  /** Câmera em edição; ausente = nova câmera. */
  camera?: Camera;
  /** Pré-preenchimento (ex.: vindo da busca na rede). */
  initial?: Partial<Form>;
  homes: Home[];
  /** Casa selecionada no painel: destino de uma câmera nova. */
  homeId: string;
  onSaved: () => void;
  onCancel: () => void;
}

export const inputCls =
  'w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20';

export function CameraForm({ camera, initial, homes, homeId, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<Form>(() => ({
    homeId: camera?.homeId ?? homeId,
    name: camera?.name ?? initial?.name ?? '',
    host: camera?.host ?? initial?.host ?? '',
    username: camera?.username ?? initial?.username ?? 'admin',
    password: '',
    protocol: camera?.protocol ?? initial?.protocol ?? 'rtsp',
    rtspPort: camera?.rtspPort ?? 554,
    dvripPort: camera?.dvripPort ?? 34567,
    channel: camera?.channel ?? 1,
    lenses: camera?.lenses ?? 'auto',
    ptzLens: camera?.ptzLens ?? 'bottom',
    lensNames: camera?.lensNames ?? { top: 'Fixa', bottom: 'Móvel' },
    recording: camera?.recording ?? { continuous: false, quality: 'sd' },
    events: camera?.events ?? { enabled: true, clip: true },
  }));
  const [test, setTest] = useState<TestResult | 'running' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key !== 'name' && key !== 'homeId' && key !== 'lensNames' && key !== 'ptzLens' && key !== 'lenses' && key !== 'recording' && key !== 'events') setTest(null);
  };

  const runTest = async () => {
    setTest('running');
    try {
      const result = await api.test({ ...form, id: camera?.id });
      // o teste tenta os dois protocolos: adota o que funcionou
      if (result.ok && result.protocol && result.protocol !== form.protocol) {
        setForm((f) => ({ ...f, protocol: result.protocol! }));
      }
      setTest(result);
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (camera) await api.update(camera.id, form);
      else await api.create(form);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <Section title="Conexão">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome">
            <input className={inputCls} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Garagem" required autoFocus />
          </Field>
          <Field label="IP da câmera" hint="ICSee → câmera → ⚙ → Informações do dispositivo">
            <input className={`${inputCls} font-mono`} value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="192.168.0.50" required />
          </Field>
          <Field label="Usuário">
            <input className={inputCls} value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Senha do dispositivo" hint={camera?.hasPassword ? 'Deixe em branco para manter a atual' : 'A do dispositivo no ICSee, não a da sua conta'}>
            <input
              className={inputCls}
              type="password"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
              placeholder={camera?.hasPassword ? '••••••••' : ''}
            />
          </Field>
          {homes.length > 1 && (
            <Field label="Casa" hint="Onde a câmera está instalada">
              <select className={inputCls} value={form.homeId} onChange={(e) => set('homeId', e.target.value)}>
                {homes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </Section>

      <Section title="Lentes">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo" hint="Câmeras de 2 lentes mandam as duas imagens no mesmo vídeo">
            <select className={inputCls} value={form.lenses} onChange={(e) => set('lenses', e.target.value as Lenses)}>
              <option value="auto">Detectar automaticamente</option>
              <option value="single">Uma lente</option>
              <option value="dual">Duas lentes (fixa + móvel)</option>
            </select>
          </Field>
          {form.lenses !== 'single' && (
            <Field label="Lente móvel (PTZ)" hint="Qual imagem gira quando você usa o controle">
              <select className={inputCls} value={form.ptzLens} onChange={(e) => set('ptzLens', e.target.value as Form['ptzLens'])}>
                <option value="bottom">Imagem de baixo</option>
                <option value="top">Imagem de cima</option>
              </select>
            </Field>
          )}
          {form.lenses !== 'single' && (
            <>
              <Field label="Nome da imagem de cima">
                <input className={inputCls} value={form.lensNames.top} onChange={(e) => set('lensNames', { ...form.lensNames, top: e.target.value })} />
              </Field>
              <Field label="Nome da imagem de baixo">
                <input className={inputCls} value={form.lensNames.bottom} onChange={(e) => set('lensNames', { ...form.lensNames, bottom: e.target.value })} />
              </Field>
            </>
          )}
        </div>
      </Section>

      <Section title="Eventos">
        <div className="space-y-3 rounded-xl border border-white/10 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.events.enabled}
              onChange={(e) => set('events', { ...form.events, enabled: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-[13px] font-medium text-zinc-200">Registrar detecções no histórico</span>
              <span className="block text-[11px] text-zinc-500">
                Recebe os alarmes da câmera (pessoa, movimento) e salva cada um com foto. Usa a detecção configurada no app ICSee.
              </span>
            </span>
          </label>
          {form.events.enabled && (
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={form.events.clip}
                onChange={(e) => set('events', { ...form.events, clip: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-emerald-500"
              />
              <span>
                <span className="block text-[13px] font-medium text-zinc-200">Gravar clipe de cada detecção</span>
                <span className="block text-[11px] text-zinc-500">Vídeo em HD a partir do alarme, de 15s a 2min (≈ 2–15 MB cada).</span>
              </span>
            </label>
          )}
        </div>
      </Section>

      <Section title="Gravação">
        <div className="space-y-3 rounded-xl border border-white/10 p-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={form.recording.continuous}
              onChange={(e) => set('recording', { ...form.recording, continuous: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-emerald-500"
            />
            <span>
              <span className="block text-[13px] font-medium text-zinc-200">Gravar o tempo todo</span>
              <span className="block text-[11px] text-zinc-500">
                Grava sem parar em arquivos de 10 minutos. Quando o espaço configurado acaba, as gravações mais antigas são apagadas.
              </span>
            </span>
          </label>
          {form.recording.continuous && (
            <Field label="Qualidade da gravação contínua" hint="Estimativa por câmera; varia com a configuração de vídeo no ICSee">
              <select
                className={inputCls}
                value={form.recording.quality}
                onChange={(e) => set('recording', { ...form.recording, quality: e.target.value as 'hd' | 'sd' })}
              >
                <option value="sd">SD — menor (≈ 0,2–0,5 GB por hora)</option>
                <option value="hd">HD — melhor imagem (≈ 0,5–1 GB por hora)</option>
              </select>
            </Field>
          )}
        </div>
      </Section>

      <div className="rounded-xl border border-white/10">
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-zinc-400 hover:text-zinc-200">
          Avançado
          <ChevronDown className={`ml-auto h-4 w-4 transition ${advanced ? 'rotate-180' : ''}`} />
        </button>
        {advanced && (
          <div className="grid gap-4 border-t border-white/10 p-4 sm:grid-cols-2">
            <Field label="Protocolo do vídeo" hint="O teste escolhe sozinho o que funcionar">
              <select className={inputCls} value={form.protocol} onChange={(e) => set('protocol', e.target.value as Form['protocol'])}>
                <option value="rtsp">RTSP (recomendado)</option>
                <option value="dvrip">DVRIP / XMeye</option>
              </select>
            </Field>
            <Field label="Canal" hint="1 para câmeras avulsas; NVR/DVR têm vários">
              <input className={inputCls} type="number" min={1} value={form.channel} onChange={(e) => set('channel', Number(e.target.value) || 1)} />
            </Field>
            <Field label="Porta RTSP">
              <input className={`${inputCls} font-mono`} type="number" value={form.rtspPort} onChange={(e) => set('rtspPort', e.target.value === '' ? '' : Number(e.target.value))} />
            </Field>
            <Field label="Porta DVRIP" hint="Usada também para o controle PTZ">
              <input className={`${inputCls} font-mono`} type="number" value={form.dvripPort} onChange={(e) => set('dvripPort', e.target.value === '' ? '' : Number(e.target.value))} />
            </Field>
          </div>
        )}
      </div>

      {test && <TestBanner test={test} />}
      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">{error}</div>}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-4">
        <button
          type="button"
          onClick={runTest}
          disabled={!form.host || test === 'running'}
          className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm font-medium transition hover:bg-white/5 disabled:opacity-50"
        >
          <Plug className="h-4 w-4" />
          Testar conexão
        </button>
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-zinc-200">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            {saving ? 'Salvando…' : camera ? 'Salvar alterações' : 'Adicionar câmera'}
          </button>
        </div>
      </div>
    </form>
  );
}

function TestBanner({ test }: { test: TestResult | 'running' }) {
  if (test === 'running') {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2.5 text-sm text-zinc-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        Conectando na câmera… (até 30s)
      </div>
    );
  }
  if (!test.ok) {
    return (
      <div className="flex gap-2 rounded-lg bg-red-500/10 px-3 py-2.5 text-sm text-red-300 ring-1 ring-red-500/20">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        {test.error}
      </div>
    );
  }
  const codecs = test.codecs?.map((c) => c.split(',').slice(-1)[0].trim()).join(' · ');
  return (
    <div className="flex gap-2 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200 ring-1 ring-emerald-500/20">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
      <div>
        <div className="font-medium">Conectado via {test.protocol?.toUpperCase()}</div>
        <div className="mt-0.5 text-xs text-emerald-300/70">
          {[test.model, codecs, test.ptz ? 'PTZ disponível' : test.ptz === false ? 'sem PTZ' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-zinc-300">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}
