import { ChevronLeft, ChevronRight, Grid2x2, Grid3x3, LayoutGrid, Maximize2, Move, Plus, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAim } from '../components/Aim';
import { CameraPlayer, type PlayerElement, type PlayerState } from '../components/CameraPlayer';
import { PtzPad } from '../components/PtzPad';
import { TalkControls } from '../components/TalkControls';
import { type Camera, DUAL_ASPECT_THRESHOLD, type View, viewsOf } from '../lib/api';

const LAYOUTS = [
  { id: 'auto', label: 'Automático', icon: LayoutGrid, cls: 'grid-cols-1 md:grid-cols-2 2xl:grid-cols-3' },
  { id: '1', label: '1 por linha', icon: Square, cls: 'grid-cols-1' },
  { id: '2', label: '2×2', icon: Grid2x2, cls: 'grid-cols-1 md:grid-cols-2' },
  { id: '3', label: '3×3', icon: Grid3x3, cls: 'grid-cols-2 lg:grid-cols-3' },
] as const;
type LayoutId = (typeof LAYOUTS)[number]['id'];

function loadLayout(): LayoutId {
  try {
    const v = localStorage.getItem('camview.layout');
    return LAYOUTS.some((l) => l.id === v) ? (v as LayoutId) : 'auto';
  } catch {
    return 'auto';
  }
}

interface Props {
  cameras: Camera[];
  reachable: Record<string, boolean>;
  focusedKey: string | null;
  onFocus: (key: string | null) => void;
  onDetectLenses: (cam: Camera, lenses: 'single' | 'dual') => void;
  onCameraUpdated: () => void;
  onManage: () => void;
}

export function Live({ cameras, reachable, focusedKey, onFocus, onDetectLenses, onCameraUpdated, onManage }: Props) {
  const [layout, setLayout] = useState<LayoutId>(loadLayout);
  const views = useMemo(() => cameras.flatMap(viewsOf), [cameras]);
  const focusedIndex = views.findIndex((v) => v.key === focusedKey);

  useEffect(() => {
    try {
      localStorage.setItem('camview.layout', layout);
    } catch {}
  }, [layout]);

  if (cameras.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-10">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/30">
            <Plus className="h-6 w-6 text-emerald-400" />
          </div>
          <h2 className="mt-5 text-lg font-semibold">Nenhuma câmera cadastrada</h2>
          <p className="mt-1.5 max-w-sm text-sm text-zinc-400">Adicione as câmeras do ICSee para acompanhar tudo ao vivo por aqui.</p>
          <button onClick={onManage} className="mt-6 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400">
            Adicionar câmera
          </button>
        </div>
      </div>
    );
  }

  const layoutCls = LAYOUTS.find((l) => l.id === layout)!.cls;

  return (
    <div className="p-4 lg:p-5">
      <div className="mb-4 flex items-center gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Monitoramento ao vivo</h2>
          <p className="text-xs text-zinc-500">
            {views.length} {views.length === 1 ? 'visualização' : 'visualizações'} · {cameras.length}{' '}
            {cameras.length === 1 ? 'câmera' : 'câmeras'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              title={l.label}
              onClick={() => setLayout(l.id)}
              className={`rounded-md p-1.5 transition ${layout === l.id ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
            >
              <l.icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      <div className={`grid gap-3 ${layoutCls}`}>
        {views.map((view) => (
          <Tile
            key={view.key}
            view={view}
            reachable={reachable[view.camera.id]}
            onOpen={() => onFocus(view.key)}
            onDetectLenses={onDetectLenses}
          />
        ))}
      </div>

      {focusedIndex >= 0 && <Viewer views={views} index={focusedIndex} onFocus={onFocus} onCameraUpdated={onCameraUpdated} />}
    </div>
  );
}

function LiveBadge({ status }: { status: PlayerState }) {
  if (status.state !== 'live') return null;
  return (
    <span className="flex items-center gap-1 rounded bg-red-600/90 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white uppercase shadow">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
      Ao vivo
    </span>
  );
}

function StatusDot({ status, reachable }: { status: PlayerState; reachable?: boolean }) {
  const color =
    status.state === 'live'
      ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/70'
      : reachable === false || status.state === 'error'
        ? 'bg-red-500'
        : 'bg-amber-400';
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function Tile({
  view,
  reachable,
  onOpen,
  onDetectLenses,
}: {
  view: View;
  reachable?: boolean;
  onOpen: () => void;
  onDetectLenses: Props['onDetectLenses'];
}) {
  const [status, setStatus] = useState<PlayerState>({ state: 'loading' });
  const cam = view.camera;

  const handleStatus = useCallback(
    (s: PlayerState) => {
      setStatus(s);
      // descobre sozinho se a câmera manda duas lentes empilhadas no quadro
      if (cam.lenses === 'auto' && s.state === 'live' && s.width && s.height) {
        onDetectLenses(cam, s.height / s.width > DUAL_ASPECT_THRESHOLD ? 'dual' : 'single');
      }
    },
    [cam, onDetectLenses],
  );

  return (
    <button
      onClick={onOpen}
      className="group relative aspect-video overflow-hidden rounded-xl bg-black text-left ring-1 ring-white/10 transition hover:ring-emerald-500/50"
    >
      <div className="cv-scanlines absolute inset-0">
        <CameraPlayer stream={cam.streams.sd} crop={view.crop} fit="cover" onStatus={handleStatus} />
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-3 pt-2.5 pb-6">
        <StatusDot status={status} reachable={reachable} />
        <span className="truncate text-[13px] font-semibold tracking-tight text-white drop-shadow">{cam.name}</span>
        {view.lensLabel && (
          <span
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
              view.ptz ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-white/10 text-zinc-300'
            }`}
          >
            {view.ptz && <Move className="h-2.5 w-2.5" />}
            {view.lensLabel}
          </span>
        )}
        {!view.lensLabel && view.ptz && (
          <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 uppercase ring-1 ring-emerald-500/40">
            <Move className="h-2.5 w-2.5" />
            PTZ
          </span>
        )}
        <span className="ml-auto">
          <LiveBadge status={status} />
        </span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 to-transparent px-3 pt-6 pb-2 opacity-0 transition group-hover:opacity-100">
        <span className="font-mono text-[10px] text-zinc-400">
          {cam.host} {status.mode && `· ${status.mode}`}
        </span>
        <span className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
          <Maximize2 className="h-3 w-3" />
          Abrir
        </span>
      </div>
    </button>
  );
}

function Viewer({
  views,
  index,
  onFocus,
  onCameraUpdated,
}: {
  views: View[];
  index: number;
  onFocus: (key: string | null) => void;
  onCameraUpdated: () => void;
}) {
  const view = views[index];
  const cam = view.camera;
  const [quality, setQuality] = useState<'hd' | 'sd'>('hd');
  const [status, setStatus] = useState<PlayerState>({ state: 'loading' });
  const [listening, setListening] = useState(false);
  const sibling = views.find((v) => v.camera.id === cam.id && v.key !== view.key);

  // vídeo principal: usado pelo áudio ("Ouvir") e pela mira (captura de quadros)
  const mainEl = useRef<PlayerElement | null>(null);
  const getVideo = useCallback(() => mainEl.current?.video ?? null, []);
  const applyListening = useCallback(() => {
    const v = mainEl.current?.video;
    if (v) {
      v.muted = !listening;
      if (listening) v.play().catch(() => {});
    }
  }, [listening]);
  useEffect(applyListening, [applyListening, status.state]);
  const aim = useAim(view, getVideo, onCameraUpdated);

  const go = useCallback((delta: number) => onFocus(views[(index + delta + views.length) % views.length].key), [index, views, onFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFocus(null);
      // setas ficam com o PTZ quando a lente é móvel
      if (!view.ptz && e.key === 'ArrowRight') go(1);
      if (!view.ptz && e.key === 'ArrowLeft') go(-1);
      if (e.key === ']' || e.key === 'PageDown') go(1);
      if (e.key === '[' || e.key === 'PageUp') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onFocus, view.ptz]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* barra superior */}
      <div className="flex items-center gap-3 border-b border-white/5 bg-zinc-950/90 px-4 py-2.5 backdrop-blur">
        <StatusDot status={status} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{view.label}</div>
          <div className="font-mono text-[10px] text-zinc-500">
            {cam.host}
            {cam.model && ` · ${cam.model}`}
            {status.mode && ` · ${status.mode}`}
          </div>
        </div>
        <LiveBadge status={status} />

        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg border border-white/10 p-0.5 text-[11px] font-semibold">
            {(['hd', 'sd'] as const).map((q) => (
              <button
                key={q}
                onClick={() => setQuality(q)}
                className={`rounded-md px-2.5 py-1 uppercase transition ${quality === q ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
              >
                {q}
              </button>
            ))}
          </div>
          {views.length > 1 && (
            <div className="flex">
              <IconButton onClick={() => go(-1)} title="Anterior ( [ )">
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <IconButton onClick={() => go(1)} title="Próxima ( ] )">
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </div>
          )}
          <IconButton onClick={() => onFocus(null)} title="Fechar (Esc)">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {/* vídeo principal */}
      <div className="relative min-h-0 flex-1">
        <CameraPlayer
          key={`${view.key}-${quality}`}
          stream={cam.streams[quality]}
          crop={view.crop}
          onStatus={setStatus}
          onElement={(el) => {
            mainEl.current = el;
          }}
          onPointClick={aim.onPointClick}
        >
          {aim.overlay}
        </CameraPlayer>

        {/* outra lente da mesma câmera (picture-in-picture) */}
        {sibling && (
          <button
            onClick={() => onFocus(sibling.key)}
            className="group absolute top-4 right-4 aspect-video w-56 overflow-hidden rounded-lg bg-black shadow-2xl ring-1 ring-white/20 transition hover:ring-emerald-400/60 max-sm:w-36"
          >
            <CameraPlayer stream={cam.streams.sd} crop={sibling.crop} fit="cover" />
            <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1 text-left text-[10px] font-semibold tracking-wide text-white uppercase">
              {sibling.lensLabel} · trocar
            </span>
          </button>
        )}

        <div className="absolute bottom-4 left-4">
          <TalkControls talkStream={cam.streams.talk} listening={listening} onListeningChange={setListening} />
        </div>

        {(view.ptz || aim.panel) && (
          <div className="absolute right-4 bottom-4 flex flex-col items-end gap-2">
            {aim.panel}
            {view.ptz && <PtzPad cameraId={cam.id} />}
          </div>
        )}
      </div>

      {/* miniaturas */}
      {views.length > 1 && (
        <div className="cv-scroll flex gap-2 overflow-x-auto border-t border-white/5 bg-zinc-950/90 p-2">
          {views.map((v) => (
            <button
              key={v.key}
              onClick={() => onFocus(v.key)}
              className={`relative flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-xs transition ${
                v.key === view.key ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              {v.ptz && <Move className="h-3 w-3" />}
              {v.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className="rounded-lg p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white" />;
}
