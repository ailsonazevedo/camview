import { Activity, Cctv, Move, Server, Settings2, ShieldCheck, TriangleAlert, Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Camera, viewsOf } from './lib/api';
import { Live } from './pages/Live';
import { Manage } from './pages/Manage';

type Page = 'live' | 'manage';

const pageFromHash = (): Page => (location.hash === '#/cameras' ? 'manage' : 'live');

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [reachable, setReachable] = useState<Record<string, boolean>>({});
  const [backend, setBackend] = useState<{ ok: boolean; go2rtc: boolean } | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const go = (p: Page) => {
    location.hash = p === 'manage' ? '#/cameras' : '#/';
  };

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setCameras(await api.list());
      setReachable(await api.status());
    } catch {
      setCameras((c) => c ?? []);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // saúde do backend/go2rtc + alcance das câmeras a cada 15s
  useEffect(() => {
    const tick = async () => {
      setBackend(await api.health().catch(() => ({ ok: false, go2rtc: false })));
      setReachable(await api.status().catch(() => ({})));
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, []);

  // detecção automática de lentes: salva uma vez por câmera
  const detecting = useRef(new Set<string>());
  const onDetectLenses = useCallback(
    async (cam: Camera, lenses: 'single' | 'dual') => {
      if (detecting.current.has(cam.id)) return;
      detecting.current.add(cam.id);
      await api.update(cam.id, { lenses }).catch(() => detecting.current.delete(cam.id));
      refresh();
    },
    [refresh],
  );

  const openView = (key: string) => {
    setFocusedKey(key);
    go('live');
  };

  const online = cameras?.filter((c) => reachable[c.id]).length ?? 0;
  const systemOk = backend?.ok && backend.go2rtc;

  return (
    <div className="flex min-h-screen text-zinc-100">
      {/* barra lateral */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-white/5 bg-zinc-950/70 backdrop-blur-xl lg:flex">
        <Brand />
        <nav className="space-y-0.5 px-3">
          <NavItem icon={Video} active={page === 'live'} onClick={() => go('live')}>
            Ao vivo
          </NavItem>
          <NavItem icon={Settings2} active={page === 'manage'} onClick={() => go('manage')}>
            Câmeras
          </NavItem>
        </nav>

        <div className="mt-6 px-5 text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Dispositivos</div>
        <div className="cv-scroll mt-2 flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {cameras?.map((cam) => (
            <div key={cam.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2">
              <div className="flex items-center gap-2 px-1">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    reachable[cam.id] === undefined ? 'bg-zinc-600' : reachable[cam.id] ? 'bg-emerald-400' : 'bg-red-500'
                  }`}
                />
                <span className="truncate text-[13px] font-medium">{cam.name}</span>
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{cam.host.split('.').slice(-1)}</span>
              </div>
              <div className="mt-1 space-y-0.5">
                {viewsOf(cam).map((v) => (
                  <button
                    key={v.key}
                    onClick={() => openView(v.key)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition ${
                      focusedKey === v.key ? 'bg-emerald-500/10 text-emerald-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
                    }`}
                  >
                    {v.ptz ? <Move className="h-3 w-3" /> : <Cctv className="h-3 w-3" />}
                    {v.lensLabel ?? 'Visualizar'}
                    {v.ptz && <span className="ml-auto text-[9px] font-semibold tracking-wider text-emerald-500/80 uppercase">PTZ</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-1.5 border-t border-white/5 p-4 text-[11px]">
          <SysRow icon={Server} label="Servidor" ok={backend?.ok} />
          <SysRow icon={Activity} label="Stream (go2rtc)" ok={backend?.go2rtc} />
          <div className="flex items-center gap-2 text-zinc-500">
            <Cctv className="h-3.5 w-3.5" />
            Câmeras online
            <span className="ml-auto font-mono text-zinc-300">
              {online}/{cameras?.length ?? 0}
            </span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* cabeçalho */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-white/5 bg-zinc-950/70 px-4 py-2.5 backdrop-blur-xl lg:px-5">
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <nav className="flex gap-1 lg:hidden">
            <NavItem icon={Video} active={page === 'live'} onClick={() => go('live')} compact>
              Ao vivo
            </NavItem>
            <NavItem icon={Settings2} active={page === 'manage'} onClick={() => go('manage')} compact>
              Câmeras
            </NavItem>
          </nav>
          <div
            className={`hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium sm:flex ${
              backend === null
                ? 'text-zinc-500'
                : systemOk
                  ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20'
            }`}
          >
            {systemOk ? <ShieldCheck className="h-3.5 w-3.5" /> : <TriangleAlert className="h-3.5 w-3.5" />}
            {backend === null ? 'Verificando…' : systemOk ? 'Sistema operacional' : 'Atenção'}
          </div>
          <div className="ml-auto">
            <Clock />
          </div>
        </header>

        {backend && !systemOk && (
          <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-sm text-amber-200">
            <TriangleAlert className="h-4 w-4" />
            {!backend.ok
              ? 'Servidor do CamView fora do ar. Rode "npm run dev" na pasta do projeto.'
              : 'go2rtc (servidor de vídeo) não está rodando. Rode "npm run dev" na pasta do projeto.'}
          </div>
        )}

        <main className="min-h-0 flex-1">
          {cameras === null ? null : page === 'live' ? (
            <Live
              cameras={cameras}
              reachable={reachable}
              focusedKey={focusedKey}
              onFocus={setFocusedKey}
              onDetectLenses={onDetectLenses}
              onCameraUpdated={refresh}
              onManage={() => go('manage')}
            />
          ) : (
            <Manage cameras={cameras} reachable={reachable} onChanged={refresh} />
          )}
        </main>
      </div>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${compact ? '' : 'px-5 pt-5 pb-6'}`}>
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
        <ShieldCheck className="h-4.5 w-4.5 text-zinc-950" strokeWidth={2.5} />
      </div>
      {!compact && (
        <div>
          <div className="text-sm font-bold tracking-tight">CamView</div>
          <div className="text-[10px] tracking-wider text-zinc-500 uppercase">Central de monitoramento</div>
        </div>
      )}
    </div>
  );
}

function NavItem({
  icon: Icon,
  active,
  compact = false,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: typeof Video; active: boolean; compact?: boolean }) {
  return (
    <button
      {...props}
      className={`flex items-center gap-2.5 rounded-lg text-sm font-medium transition ${compact ? 'px-2.5 py-1.5' : 'w-full px-3 py-2'} ${
        active ? 'bg-white/[0.07] text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-emerald-400' : ''}`} />
      {children}
    </button>
  );
}

function SysRow({ icon: Icon, label, ok }: { icon: typeof Video; label: string; ok?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-zinc-500">
      <Icon className="h-3.5 w-3.5" />
      {label}
      <span className={`ml-auto flex items-center gap-1.5 ${ok === undefined ? 'text-zinc-600' : ok ? 'text-emerald-400' : 'text-red-400'}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok === undefined ? 'bg-zinc-600' : ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
        {ok === undefined ? '—' : ok ? 'OK' : 'Falha'}
      </span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-right leading-tight">
      <div className="font-mono text-sm font-medium tabular-nums">{now.toLocaleTimeString('pt-BR')}</div>
      <div className="text-[10px] tracking-wide text-zinc-500 uppercase">
        {now.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}
      </div>
    </div>
  );
}
