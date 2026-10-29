import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Cctv,
  CircleHelp,
  Clock,
  Cpu,
  Layers,
  Loader2,
  Move,
  Network,
  Pencil,
  Plus,
  Radar,
  RefreshCw,
  Tag,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { CameraForm } from '../components/CameraForm';
import { api, type Camera, type CameraForm as Form, type CameraHealth, type FoundDevice, type Home, type RelocateResult } from '../lib/api';

interface Props {
  /** Câmeras da casa selecionada. */
  cameras: Camera[];
  homes: Home[];
  home: Home;
  reachable: Record<string, boolean>;
  onChanged: () => void;
}

type Editing = { camera?: Camera; initial?: Partial<Form> } | null;

export function Manage({ cameras, homes, home, reachable, onChanged }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [found, setFound] = useState<FoundDevice[] | 'scanning' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [healthOpen, setHealthOpen] = useState<string | null>(null);
  const [relocation, setRelocation] = useState<RelocateResult | 'searching' | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const offline = cameras.filter((c) => reachable[c.id] === false).length;

  const relocate = async () => {
    setRelocation('searching');
    setError(null);
    try {
      const result = await api.relocate();
      setRelocation(result);
      if (result.moved.length > 0) onChanged();
    } catch (err) {
      setRelocation(null);
      setError((err as Error).message);
    }
  };

  /** Escolha manual: "a câmera X é este IP". */
  const chooseHost = async (cameraId: string, host: string) => {
    setChoosing(`${cameraId}@${host}`);
    try {
      const cam = await api.relocateTo(cameraId, host);
      setRelocation((cur) =>
        cur && cur !== 'searching'
          ? {
              ...cur,
              moved: [...cur.moved, { id: cam.id, name: cam.name, from: cam.lastRelocation?.from ?? '', to: host, by: 'manual' }],
              unresolved: cur.unresolved
                .filter((u) => u.id !== cameraId)
                .map((u) => ({ ...u, candidates: u.candidates.filter((c) => c.host !== host) })),
            }
          : cur,
      );
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChoosing(null);
    }
  };

  const scan = async () => {
    setFound('scanning');
    try {
      setFound(await api.discover());
    } catch (err) {
      setFound(null);
      setError((err as Error).message);
    }
  };

  const remove = async (cam: Camera) => {
    setConfirmDelete(null);
    try {
      await api.remove(cam.id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const move = async (index: number, delta: number) => {
    const ids = cameras.map((c) => c.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    await api.reorder(ids);
    onChanged();
  };

  const addFromDevice = (d: FoundDevice) => {
    setEditing({ initial: { host: d.host, name: d.name ?? '' } });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Câmeras <span className="text-zinc-500">· {home.name}</span>
          </h2>
          <p className="text-sm text-zinc-500">Cadastre, teste e organize os dispositivos desta casa.</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            onClick={relocate}
            disabled={relocation === 'searching' || cameras.length === 0}
            title="Procura na rede as câmeras que mudaram de IP e reconecta"
            className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition disabled:opacity-60 ${
              offline > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15' : 'border-white/10 hover:bg-white/5'
            }`}
          >
            <RefreshCw className={`h-4 w-4 ${relocation === 'searching' ? 'animate-spin' : ''}`} />
            {relocation === 'searching' ? 'Reconectando…' : offline > 0 ? `Reconectar câmeras (${offline} offline)` : 'Reconectar câmeras'}
          </button>
          <button
            onClick={scan}
            disabled={found === 'scanning'}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3.5 py-2 text-sm font-medium transition hover:bg-white/5 disabled:opacity-60"
          >
            {found === 'scanning' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            {found === 'scanning' ? 'Procurando…' : 'Procurar na rede'}
          </button>
          <button
            onClick={() => setEditing({})}
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
          >
            <Plus className="h-4 w-4" />
            Adicionar
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          {error}
          <button className="ml-auto" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {relocation && relocation !== 'searching' && (
        <section className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Network className="h-4 w-4 text-amber-300" />
            <h3 className="text-sm font-semibold">Reconectar câmeras</h3>
            <button onClick={() => setRelocation(null)} className="ml-auto text-zinc-500 hover:text-zinc-300">
              <X className="h-4 w-4" />
            </button>
          </div>
          {relocation.missing === 0 ? (
            <p className="text-sm text-zinc-400">Todas as câmeras estão respondendo no IP cadastrado.</p>
          ) : (
            <div className="space-y-3 text-sm">
              {relocation.moved.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-2 text-emerald-300">
                  <Wifi className="h-4 w-4" />
                  <b>{m.name}</b>
                  <span className="flex items-center gap-1 font-mono text-xs text-zinc-400">
                    {m.from} <ArrowRight className="h-3 w-3" /> {m.to}
                  </span>
                  <span className="text-xs text-zinc-500">reconectada</span>
                </div>
              ))}
              {relocation.unresolved.map((u) => (
                <div key={u.id} className="rounded-lg border border-white/5 bg-black/30 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <WifiOff className="h-4 w-4 text-red-400" />
                    <b>{u.name}</b>
                    <span className="text-xs text-zinc-500">não foi reconhecida automaticamente</span>
                  </div>
                  {u.candidates.length === 0 ? (
                    <p className="text-xs text-zinc-400">
                      Nenhum aparelho livre encontrado na rede. Confira se a câmera está ligada e conectada ao Wi‑Fi.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-zinc-400">Qual destes aparelhos é ela?</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {u.candidates.map((c) => (
                          <div key={c.host} className="flex items-center gap-3 rounded-md border border-white/5 px-3 py-2">
                            <Cctv className="h-4 w-4 shrink-0 text-zinc-500" />
                            <div className="min-w-0">
                              <div className="font-mono text-xs">{c.host}</div>
                              <div className="truncate text-[11px] text-zinc-500">
                                {[c.name, c.model, c.loginOk ? 'senha confere' : c.loginOk === false ? 'senha não confere' : null].filter(Boolean).join(' · ') ||
                                  'aparelho na rede'}
                              </div>
                            </div>
                            <button
                              onClick={() => chooseHost(u.id, c.host)}
                              disabled={choosing !== null}
                              className="ml-auto flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium hover:bg-white/15 disabled:opacity-50"
                            >
                              {choosing === `${u.id}@${c.host}` && <Loader2 className="h-3 w-3 animate-spin" />}É esta
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {Array.isArray(found) && (
        <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
          <div className="mb-3 flex items-center gap-2">
            <Wifi className="h-4 w-4 text-emerald-400" />
            <h3 className="text-sm font-semibold">Encontrados na rede</h3>
            <button onClick={() => setFound(null)} className="ml-auto text-zinc-500 hover:text-zinc-300">
              <X className="h-4 w-4" />
            </button>
          </div>
          {found.length === 0 ? (
            <p className="text-sm text-zinc-400">
              Nada encontrado. Confira se o computador está no mesmo Wi‑Fi das câmeras, ou veja o IP em ICSee → câmera → ⚙ → Informações do dispositivo.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {found.map((d) => (
                <div key={d.host} className="flex items-center gap-3 rounded-lg border border-white/5 bg-black/30 px-3 py-2.5">
                  <Cctv className="h-5 w-5 shrink-0 text-zinc-500" />
                  <div className="min-w-0">
                    <div className="font-mono text-sm">{d.host}</div>
                    <div className="truncate text-[11px] text-zinc-500">{d.xmeye ? `ICSee · ${d.name ?? ''}` : `portas ${d.ports.join(', ')}`}</div>
                  </div>
                  {d.added ? (
                    <span className="ml-auto text-[11px] text-zinc-500">adicionada</span>
                  ) : (
                    <button onClick={() => addFromDevice(d)} className="ml-auto rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium hover:bg-white/15">
                      Adicionar
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {cameras.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">
          Nenhuma câmera em {home.name} ainda. Use “Procurar na rede” para encontrar as câmeras do ICSee.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {cameras.map((cam, i) => (
            <div key={cam.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-white/15">
              <div className="flex items-start gap-3">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 ring-1 ring-white/10">
                  <Cctv className="h-5 w-5 text-zinc-300" />
                  <span
                    className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-zinc-950 ${
                      reachable[cam.id] === undefined ? 'bg-zinc-600' : reachable[cam.id] ? 'bg-emerald-400' : 'bg-red-500'
                    }`}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{cam.name}</div>
                  <div className="font-mono text-[11px] text-zinc-500">
                    {cam.host} · {cam.model ?? 'modelo desconhecido'}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge>{cam.protocol.toUpperCase()}</Badge>
                    {cam.lenses === 'dual' && (
                      <Badge>
                        <Layers className="h-3 w-3" />2 lentes
                      </Badge>
                    )}
                    {cam.lenses === 'auto' && <Badge>lentes: detectando</Badge>}
                    {cam.ptz && (
                      <Badge accent>
                        <Move className="h-3 w-3" />
                        PTZ
                      </Badge>
                    )}
                    {cam.recording?.continuous && (
                      <Badge>
                        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                        Gravação contínua · {cam.recording.quality}
                      </Badge>
                    )}
                    {cam.channel !== 1 && <Badge>canal {cam.channel}</Badge>}
                    {cam.lastRelocation && Date.now() - Date.parse(cam.lastRelocation.at) < 24 * 3600_000 && (
                      <Badge>
                        <RefreshCw className="h-3 w-3" />
                        IP atualizado · antes {cam.lastRelocation.from}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-1 border-t border-white/5 pt-3">
                <IconBtn disabled={i === 0} onClick={() => move(i, -1)} title="Mover para cima">
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn disabled={i === cameras.length - 1} onClick={() => move(i, 1)} title="Mover para baixo">
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconBtn>
                <button
                  onClick={() => setHealthOpen((cur) => (cur === cam.id ? null : cam.id))}
                  className={`ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition ${
                    healthOpen === cam.id ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                  }`}
                >
                  <Activity className="h-3 w-3" />
                  Saúde
                </button>
                <div className="ml-auto flex gap-1">
                  {confirmDelete === cam.id ? (
                    <>
                      <span className="self-center px-1 text-xs text-zinc-400">Remover?</span>
                      <button onClick={() => remove(cam)} className="rounded-md bg-red-500/20 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-500/30">
                        Sim, remover
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-white/5">
                        Não
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setEditing({ camera: cam })}
                        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/5"
                      >
                        <Pencil className="h-3 w-3" />
                        Editar
                      </button>
                      <button
                        onClick={() => setConfirmDelete(cam.id)}
                        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-red-400/80 hover:bg-red-500/10 hover:text-red-300"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remover
                      </button>
                    </>
                  )}
                </div>
              </div>

              {healthOpen === cam.id && <HealthPanel cameraId={cam.id} mac={cam.mac} online={reachable[cam.id]} />}
            </div>
          ))}
        </div>
      )}

      <Help />

      {editing && (
        <Modal title={editing.camera ? `Editar ${editing.camera.name}` : 'Nova câmera'} onClose={() => setEditing(null)}>
          <CameraForm
            camera={editing.camera}
            initial={editing.initial}
            homes={homes}
            homeId={home.id}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              onChanged();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function formatUptime(seconds?: number) {
  if (!seconds || seconds < 0) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

/** Saúde da câmera: carrega sob demanda ao abrir. */
function HealthPanel({ cameraId, mac, online }: { cameraId: string; mac?: string; online?: boolean }) {
  const [health, setHealth] = useState<CameraHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .cameraHealth(cameraId)
      .then(setHealth)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [cameraId]);

  const uptime = formatUptime(health?.uptimeSeconds);
  const rows: { icon: typeof Cpu; label: string; value: string }[] = [];
  if (health?.online) {
    if (health.firmware) rows.push({ icon: Cpu, label: 'Firmware', value: health.firmware });
    if (health.buildTime) rows.push({ icon: Clock, label: 'Compilação', value: health.buildTime });
    if (uptime) rows.push({ icon: Activity, label: 'Ligada há', value: uptime });
    if (health.serial) rows.push({ icon: Tag, label: 'Nº de série', value: health.serial });
    if (mac) rows.push({ icon: Network, label: 'MAC', value: mac });
  }

  return (
    <div className="mt-3 rounded-lg border border-white/5 bg-black/20 p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        {online === false ? (
          <span className="flex items-center gap-1.5 font-medium text-red-300">
            <WifiOff className="h-3.5 w-3.5" /> Offline na rede
          </span>
        ) : (
          <span className="flex items-center gap-1.5 font-medium text-emerald-300">
            <Wifi className="h-3.5 w-3.5" /> Online
          </span>
        )}
        {health?.online && health.wifiSignal != null && (
          <span className="flex items-center gap-1 text-zinc-400">
            <Wifi className="h-3.5 w-3.5" /> Sinal {health.wifiSignal}%
          </span>
        )}
        <button onClick={load} disabled={loading} className="ml-auto rounded-md px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Atualizar'}
        </button>
      </div>

      {loading ? (
        <p className="text-zinc-500">Consultando a câmera…</p>
      ) : error ? (
        <p className="text-red-300/90">{error}</p>
      ) : health && !health.online ? (
        <p className="text-amber-300/90">Não respondeu pelo controle (DVRIP){health.error ? `: ${health.error}` : ''}.</p>
      ) : rows.length === 0 ? (
        <p className="text-zinc-500">A câmera não informou detalhes de firmware.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="flex items-center gap-1.5 text-zinc-500">
                <r.icon className="h-3.5 w-3.5" />
                {r.label}
              </dt>
              <dd className="truncate font-mono text-zinc-300" title={r.value}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="my-auto h-fit w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl shadow-black"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-white/5 px-5 py-4">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-white/5 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Badge({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
        accent ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30' : 'bg-white/5 text-zinc-400 ring-1 ring-white/10'
      }`}
    >
      {children}
    </span>
  );
}

function IconBtn({ className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-30 ${className}`} />;
}

function Help() {
  return (
    <details className="group rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-400">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-zinc-300">
        <CircleHelp className="h-4 w-4 text-zinc-500" />
        Como conectar câmeras do ICSee
      </summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5">
        <li>O computador precisa estar na mesma rede (Wi‑Fi/cabo) que as câmeras.</li>
        <li>
          <b className="text-zinc-300">Descubra o IP</b> com “Procurar na rede”. Vale fixar o IP de cada câmera no roteador (reserva DHCP); se o IP mudar mesmo assim, use “Reconectar câmeras”.
        </li>
        <li>
          <b className="text-zinc-300">Usuário e senha do dispositivo</b>: no ICSee, abra a câmera → ⚙ → <i>Senha do dispositivo</i> / <i>Alterar senha</i>. É a
          senha da câmera, não a da sua conta ICSee.
        </li>
        <li>
          <b className="text-zinc-300">Não aparece a opção de senha?</b> Isso acontece quando a câmera foi <i>compartilhada</i> com sua conta (só o dono vê) ou
          com firmwares que escondem a senha. Peça ao dono da conta para definir a senha, ou faça o reset da câmera (botão reset ~10s) e adicione-a de novo
          no ICSee pela sua conta, definindo a senha durante a configuração.
        </li>
        <li>
          Câmeras de <b className="text-zinc-300">duas lentes</b> mandam as duas imagens no mesmo vídeo; o CamView separa em dois blocos sozinho. O controle
          PTZ aparece ao abrir a lente móvel.
        </li>
      </ol>
    </details>
  );
}
