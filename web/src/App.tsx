import { Activity, Bell, Cctv, Film, Move, Server, Settings2, ShieldCheck, SlidersHorizontal, TriangleAlert, Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EventToasts, type ToastItem } from './components/EventBits';
import { api, type Camera, type CameraEvent, type Health, type RecordingStatus, viewsOf } from './lib/api';
import { eventLabel, showSystemNotification, useEventStream } from './lib/events';
import { Live } from './pages/Live';
import { Events } from './pages/Events';
import { Manage } from './pages/Manage';
import { Recordings } from './pages/Recordings';
import { Settings } from './pages/Settings';

type Page = 'live' | 'manage' | 'recordings' | 'events' | 'settings';

const HASHES: Record<Page, string> = { live: '#/', manage: '#/cameras', recordings: '#/gravacoes', events: '#/eventos', settings: '#/configuracoes' };

const pageFromHash = (): Page =>
  location.hash === '#/cameras'
    ? 'manage'
    : location.hash.startsWith('#/gravacoes')
      ? 'recordings'
      : location.hash.startsWith('#/eventos')
        ? 'events'
        : location.hash === '#/configuracoes'
          ? 'settings'
          : 'live';

/** #/eventos/<id> abre o evento direto. */
const eventFromHash = () => (location.hash.startsWith('#/eventos/') ? decodeURIComponent(location.hash.slice('#/eventos/'.length)) : null);

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [reachable, setReachable] = useState<Record<string, boolean>>({});
  const [backend, setBackend] = useState<Health | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const [recStatus, setRecStatus] = useState<Record<string, RecordingStatus>>({});
  const [openEventId, setOpenEventId] = useState<string | null>(eventFromHash);
  const [unseen, setUnseen] = useState(0);
  const [liveEvents, setLiveEvents] = useState<CameraEvent[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const go = (p: Page, sub?: string) => {
    location.hash = HASHES[p] + (sub ? `/${sub}` : '');
  };

  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash());
      setOpenEventId(eventFromHash());
    };
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

  // eventos em tempo real
  const camerasRef = useRef<Camera[]>([]);
  camerasRef.current = cameras ?? [];
  const openEvent = useCallback((e: CameraEvent) => {
    setFocusedKey(null);
    location.hash = `#/eventos/${encodeURIComponent(e.id)}`;
  }, []);
  useEventStream((kind, event) => {
    setLiveEvents((cur) => [event, ...cur.filter((e) => e.id !== event.id)].slice(0, 200));
    if (kind === 'new') {
      setUnseen((n) => n + 1);
      const key = `${event.id}-${Date.now()}`;
      setToasts((cur) => [{ event, key }, ...cur].slice(0, 4));
      setTimeout(() => setToasts((cur) => cur.filter((t) => t.key !== key)), 10_000);
      const cam = camerasRef.current.find((c) => c.id === event.cameraId);
      showSystemNotification(eventLabel(event), `${cam?.name ?? event.cameraId} · ${new Date(event.start).toLocaleTimeString('pt-BR')}`, null, () => openEvent(event));
    } else {
      // a foto chega logo depois: atualiza a imagem do aviso
      setToasts((cur) => cur.map((t) => (t.event.id === event.id ? { ...t, event } : t)));
    }
  });
  useEffect(() => {
    const tick = () => api.eventsSummary().then((s) => setUnseen(s.unseen)).catch(() => {});
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  // detecções acontecendo agora (destaque nos blocos ao vivo); redesenha
  // logo depois que um alarme termina para tirar o destaque
  const [, setTick] = useState(0);
  useEffect(() => {
    const ending = liveEvents.filter((e) => e.end && Date.now() - new Date(e.end).getTime() < 3000);
    if (!ending.length) return;
    const id = setTimeout(() => setTick((n) => n + 1), 3100);
    return () => clearTimeout(id);
  }, [liveEvents]);
  const activeEvents = Object.fromEntries(
    liveEvents.filter((e) => e.end === null || Date.now() - new Date(e.end).getTime() < 3000).map((e) => [e.cameraId, e]),
  ) as Record<string, CameraEvent>;

  // quais câmeras estão gravando (manual ou contínua)
  useEffect(() => {
    const tick = () => api.recordingStatus().then(setRecStatus).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

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
          <NavItem icon={Bell} active={page === 'events'} onClick={() => go('events')} badge={unseen}>
            Eventos
          </NavItem>
          <NavItem icon={Film} active={page === 'recordings'} onClick={() => go('recordings')}>
            Gravações
          </NavItem>
          <NavItem icon={Settings2} active={page === 'manage'} onClick={() => go('manage')}>
            Câmeras
          </NavItem>
          <NavItem icon={SlidersHorizontal} active={page === 'settings'} onClick={() => go('settings')}>
            Configurações
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
                {recStatus[cam.id] && (
                  <span className="flex items-center gap-1 text-[9px] font-bold tracking-wider text-red-400 uppercase" title="Gravando">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                    Rec
                  </span>
                )}
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
            <NavItem icon={Bell} active={page === 'events'} onClick={() => go('events')} compact badge={unseen}>
            Eventos
          </NavItem>
          <NavItem icon={Film} active={page === 'recordings'} onClick={() => go('recordings')} compact>
            Gravações
          </NavItem>
          <NavItem icon={Settings2} active={page === 'manage'} onClick={() => go('manage')} compact>
              Câmeras
            </NavItem>
            <NavItem icon={SlidersHorizontal} active={page === 'settings'} onClick={() => go('settings')} compact>
              Configurações
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

        {backend?.media && !backend.media.available && (
          <div className="flex flex-wrap items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-5 py-2 text-sm text-red-200">
            <TriangleAlert className="h-4 w-4 shrink-0" />
            <span>
              <b>Local de armazenamento indisponível</b> — gravações, capturas e eventos estão pausados. {backend.media.reason}
            </span>
            <span className="font-mono text-xs text-red-300/70">{backend.media.dir}</span>
            <button onClick={() => go('recordings')} className="ml-auto rounded-md bg-white/10 px-2.5 py-1 text-xs font-semibold hover:bg-white/15">
              Ver armazenamento
            </button>
          </div>
        )}

        {backend && !systemOk && (
          <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-5 py-2 text-sm text-amber-200">
            <TriangleAlert className="h-4 w-4" />
            {!backend.ok
              ? 'Servidor do CamView fora do ar. Rode "npm run dev" na pasta do projeto.'
              : 'go2rtc (servidor de vídeo) não está rodando. Rode "npm run dev" na pasta do projeto.'}
          </div>
        )}

        <EventToasts
          items={toasts}
          cameras={cameras ?? []}
          onOpen={(e) => {
            setToasts((cur) => cur.filter((t) => t.event.id !== e.id));
            openEvent(e);
          }}
          onDismiss={(key) => setToasts((cur) => cur.filter((t) => t.key !== key))}
        />

        <main className="min-h-0 flex-1">
          {cameras === null ? null : page === 'events' ? (
            <Events
              cameras={cameras}
              live={liveEvents}
              openId={openEventId}
              onOpenChange={(id) => {
                location.hash = id ? `#/eventos/${encodeURIComponent(id)}` : '#/eventos';
              }}
              onUnseenChange={setUnseen}
            />
          ) : page === 'settings' ? (
            <Settings />
          ) : page === 'recordings' ? (
            <Recordings cameras={cameras} recStatus={recStatus} />
          ) : page === 'live' ? (
            <Live
              cameras={cameras}
              reachable={reachable}
              focusedKey={focusedKey}
              onFocus={setFocusedKey}
              onDetectLenses={onDetectLenses}
              onCameraUpdated={refresh}
              onManage={() => go('manage')}
              recStatus={recStatus}
              activeEvents={activeEvents}
              onRecChanged={setRecStatus}
              onOpenGallery={() => {
                setFocusedKey(null);
                go('recordings', 'capturas');
              }}
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
  badge = 0,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: typeof Video; active: boolean; compact?: boolean; badge?: number }) {
  return (
    <button
      {...props}
      className={`flex items-center gap-2.5 rounded-lg text-sm font-medium transition ${compact ? 'px-2.5 py-1.5' : 'w-full px-3 py-2'} ${
        active ? 'bg-white/[0.07] text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
      }`}
    >
      <Icon className={`h-4 w-4 ${active ? 'text-emerald-400' : ''}`} />
      <span className={compact ? 'max-sm:hidden' : ''}>{children}</span>
      {badge > 0 && (
        <span className="ml-auto min-w-[18px] rounded-full bg-orange-500 px-1.5 text-center text-[10px] leading-[18px] font-bold text-white tabular-nums">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
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
