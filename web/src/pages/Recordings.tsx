import { CalendarDays, Camera as CameraIcon, ChevronLeft, ChevronRight, Download, Film, HardDrive, Image as ImageIcon, Pencil, Play, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StorageLocationCard } from '../components/StorageLocationCard';
import {
  api,
  type Camera,
  type CaptureFile,
  formatBytes,
  formatDuration,
  mediaUrl,
  type RecordingFile,
  type RecordingStatus,
  type Storage,
} from '../lib/api';

type Tab = 'videos' | 'captures';

const tabFromHash = (): Tab => (location.hash.endsWith('/capturas') ? 'captures' : 'videos');

const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR');
const dateLabel = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface Props {
  cameras: Camera[];
  recStatus: Record<string, RecordingStatus>;
}

export function Recordings({ cameras, recStatus }: Props) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [storage, setStorage] = useState<Storage | null>(null);
  // muda ao trocar de local: recarrega as listas
  const [reloadKey, setReloadKey] = useState(0);
  const camName = useCallback((id: string) => cameras.find((c) => c.id === id)?.name ?? id, [cameras]);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshStorage = useCallback(() => api.storage().then(setStorage).catch(() => {}), []);
  useEffect(() => {
    refreshStorage();
  }, [refreshStorage]);

  const goTab = (t: Tab) => {
    location.hash = t === 'captures' ? '#/gravacoes/capturas' : '#/gravacoes';
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Gravações</h2>
          <p className="text-sm text-zinc-500">Vídeos gravados e imagens capturadas neste computador.</p>
        </div>
        <div className="ml-auto">{storage && <StorageMeter storage={storage} onSaved={refreshStorage} />}</div>
      </div>

      {storage && (
        <StorageLocationCard
          retentionGB={storage.settings.retentionGB}
          onChanged={() => {
            refreshStorage();
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      <div className="flex gap-1 border-b border-white/5">
        {(
          [
            ['videos', 'Vídeos', Film],
            ['captures', 'Capturas', ImageIcon],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => goTab(id)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === id ? 'border-emerald-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-200'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'videos' ? (
        <Videos key={reloadKey} cameras={cameras} camName={camName} recStatus={recStatus} onChanged={refreshStorage} />
      ) : (
        <Captures key={reloadKey} cameras={cameras} camName={camName} onChanged={refreshStorage} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- espaço

function StorageMeter({ storage, onSaved }: { storage: Storage; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(storage.settings.retentionGB));
  const pct = Math.min(100, (storage.recordingsBytes / storage.limitBytes) * 100);

  const save = async () => {
    const gb = Number(value);
    if (!Number.isFinite(gb) || gb < 1) return;
    await api.saveSettings({ retentionGB: gb }).catch(() => {});
    setEditing(false);
    onSaved();
  };

  return (
    <div className="w-72 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs">
      <div className="flex items-center gap-2 text-zinc-400">
        <HardDrive className="h-3.5 w-3.5" />
        Espaço das gravações
        <span className="ml-auto font-mono text-zinc-200">
          {formatBytes(storage.recordingsBytes)} / {storage.settings.retentionGB} GB
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${pct > 90 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
      </div>
      {editing ? (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-20 rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono text-zinc-100 outline-none focus:border-emerald-500/60"
            autoFocus
          />
          <span className="text-zinc-500">GB</span>
          <button onClick={save} className="ml-auto rounded-md bg-emerald-500 px-2 py-1 font-semibold text-zinc-950 hover:bg-emerald-400">
            Salvar
          </button>
          <button onClick={() => setEditing(false)} className="rounded-md px-2 py-1 text-zinc-400 hover:bg-white/5">
            Cancelar
          </button>
        </div>
      ) : (
        <div className="mt-1.5 flex items-center text-[11px] text-zinc-500">
          Ao passar do limite, as mais antigas são apagadas.
          <button onClick={() => setEditing(true)} className="ml-auto flex items-center gap-1 text-zinc-400 hover:text-zinc-200" title="Alterar limite">
            <Pencil className="h-3 w-3" />
          </button>
        </div>
      )}
      {storage.capturesBytes > 0 && <div className="mt-1 text-[11px] text-zinc-600">Capturas: {formatBytes(storage.capturesBytes)} (não são apagadas)</div>}
    </div>
  );
}

// ---------------------------------------------------------------- vídeos

function Videos({
  cameras,
  camName,
  recStatus,
  onChanged,
}: {
  cameras: Camera[];
  camName: (id: string) => string;
  recStatus: Record<string, RecordingStatus>;
  onChanged: () => void;
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState(todayStr);
  const [camera, setCamera] = useState('');
  const [items, setItems] = useState<RecordingFile[] | null>(null);
  const [playing, setPlaying] = useState<RecordingFile | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ds, list] = await Promise.all([api.recordingDates(), api.recordings({ date, ...(camera && { camera }) })]);
      setDates(ds);
      setItems(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [date, camera]);

  useEffect(() => {
    load();
  }, [load]);

  // enquanto algo grava, atualiza a lista
  const anyActive = Object.keys(recStatus).length > 0;
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [anyActive, load]);

  const remove = async (r: RecordingFile) => {
    setConfirm(null);
    try {
      await api.deleteMedia(r.path);
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const dateOptions = [...new Set([todayStr(), ...dates])].sort().reverse();
  const camerasShown = camera ? cameras.filter((c) => c.id === camera) : cameras;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-sm">
          <CalendarDays className="h-4 w-4 text-zinc-500" />
          <select value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent outline-none">
            {dateOptions.map((d) => (
              <option key={d} value={d} className="bg-zinc-900">
                {d === todayStr() ? `Hoje · ${dateLabel(d)}` : dateLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <CameraSelect cameras={cameras} value={camera} onChange={setCamera} />
      </div>

      {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">{error}</div>}

      {/* linha do tempo do dia */}
      {items && items.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-3 flex text-[10px] text-zinc-600">
            <span className="w-28 shrink-0" />
            <div className="relative h-3 flex-1">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <span key={h} className="absolute -translate-x-1/2 font-mono" style={{ left: `${(h / 24) * 100}%` }}>
                  {String(h).padStart(2, '0')}h
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {camerasShown.map((c) => (
              <div key={c.id} className="flex items-center">
                <span className="w-28 shrink-0 truncate pr-3 text-xs text-zinc-400">{c.name}</span>
                <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-white/[0.04]">
                  {items
                    .filter((r) => r.cameraId === c.id)
                    .map((r) => {
                      const start = new Date(r.start);
                      const day = new Date(`${date}T00:00:00`).getTime();
                      const left = Math.max(0, (start.getTime() - day) / 864e5);
                      const width = Math.max(0.002, (new Date(r.end).getTime() - start.getTime()) / 864e5);
                      return (
                        <button
                          key={r.path}
                          onClick={() => setPlaying(r)}
                          title={`${time(r.start)} – ${time(r.end)}`}
                          className={`absolute inset-y-0 min-w-[3px] transition hover:brightness-125 ${
                            r.kind === 'manual' ? 'bg-red-500/80' : r.kind === 'event' ? 'bg-amber-400/90' : 'bg-emerald-500/70'
                          } ${r.active ? 'animate-pulse' : ''}`}
                          style={{ left: `${left * 100}%`, width: `${width * 100}%` }}
                        />
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm bg-red-500/80" />
              Manual
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm bg-emerald-500/70" />
              Contínua
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-3 rounded-sm bg-amber-400/90" />
              Evento
            </span>
          </div>
        </div>
      )}

      {items === null ? null : items.length === 0 ? (
        <Empty icon={Film} text="Nenhuma gravação neste dia. Use o botão “Gravar” na tela cheia de uma câmera, ou ligue a gravação contínua no cadastro dela." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          {items.map((r) => (
            <div key={r.path} className="flex items-center gap-3 border-b border-white/5 px-4 py-2.5 text-sm last:border-0 hover:bg-white/[0.02]">
              <button
                onClick={() => setPlaying(r)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-zinc-300 ring-1 ring-white/10 hover:bg-emerald-500/15 hover:text-emerald-300"
                title="Assistir"
              >
                <Play className="h-4 w-4 fill-current" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium tabular-nums">
                    {time(r.start)} – {r.active ? 'agora' : time(r.end)}
                  </span>
                  {r.active && (
                    <span className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-red-400 uppercase">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                      Gravando
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {camName(r.cameraId)} · {formatDuration(new Date(r.end).getTime() - new Date(r.start).getTime())} · {formatBytes(r.bytes)}
                </div>
              </div>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  r.kind === 'manual' ? 'bg-red-500/10 text-red-300' : r.kind === 'event' ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'
                }`}
              >
                {r.kind === 'manual' ? 'Manual' : r.kind === 'event' ? 'Evento' : 'Contínua'}
              </span>
              <span className="w-7 text-center text-[10px] font-semibold text-zinc-500 uppercase">{r.quality}</span>
              <a
                href={mediaUrl(r.path)}
                download
                className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                title="Baixar"
              >
                <Download className="h-4 w-4" />
              </a>
              {confirm === r.path ? (
                <span className="flex items-center gap-1">
                  <button onClick={() => remove(r)} className="rounded-md bg-red-500/20 px-2 py-1 text-xs text-red-300 hover:bg-red-500/30">
                    Apagar
                  </button>
                  <button onClick={() => setConfirm(null)} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/5">
                    Não
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirm(r.path)}
                  disabled={r.active}
                  className="rounded-md p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-30"
                  title={r.active ? 'Ainda gravando' : 'Apagar'}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {playing && <VideoModal rec={playing} camera={cameras.find((c) => c.id === playing.cameraId)} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function VideoModal({ rec, camera, onClose }: { rec: RecordingFile; camera?: Camera; onClose: () => void }) {
  const dual = camera?.lenses === 'dual';
  const [lens, setLens] = useState<'both' | 'top' | 'bottom'>(dual ? (camera!.ptzLens === 'bottom' ? 'top' : 'bottom') : 'both');
  useEscape(onClose);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur" onMouseDown={onClose}>
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3" onMouseDown={(e) => e.stopPropagation()}>
        <Film className="h-4 w-4 text-zinc-500" />
        <div>
          <div className="text-sm font-semibold">{camera?.name ?? rec.cameraId}</div>
          <div className="font-mono text-[11px] text-zinc-500">
            {new Date(rec.start).toLocaleString('pt-BR')} · {rec.quality.toUpperCase()} · {formatBytes(rec.bytes)}
          </div>
        </div>
        {dual && camera && (
          <div className="ml-4 flex rounded-lg border border-white/10 p-0.5 text-xs font-medium">
            {(
              [
                ['both', 'Ambas'],
                ['top', camera.lensNames.top],
                ['bottom', camera.lensNames.bottom],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setLens(id)}
                className={`rounded-md px-2.5 py-1 transition ${lens === id ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <a href={mediaUrl(rec.path)} download className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10">
            <Download className="h-4 w-4" />
            Baixar
          </a>
          <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-4" onMouseDown={(e) => e.stopPropagation()}>
        {lens === 'both' ? (
          <video src={mediaUrl(rec.path)} controls autoPlay className="h-full w-full object-contain" />
        ) : (
          // lente recortada: caixa 16:9 com o vídeo de altura dobrada
          <div className="cv-fit h-full w-full">
            <div className="cv-fit-box relative overflow-hidden" style={{ '--ar': 16 / 9 } as React.CSSProperties}>
              <video
                src={mediaUrl(rec.path)}
                controls
                autoPlay
                className="absolute inset-x-0 top-0 h-[200%] w-full object-fill"
                style={{ transform: lens === 'bottom' ? 'translateY(-50%)' : undefined }}
              />
            </div>
          </div>
        )}
      </div>
      {rec.active && (
        <p className="pb-3 text-center text-xs text-zinc-500">Esta gravação ainda está em andamento — o vídeo vai até o momento em que foi aberto.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- capturas

function Captures({ cameras, camName, onChanged }: { cameras: Camera[]; camName: (id: string) => string; onChanged: () => void }) {
  const [camera, setCamera] = useState('');
  const [items, setItems] = useState<CaptureFile[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => api.captures(camera || undefined).then(setItems).catch(() => setItems([])), [camera]);
  useEffect(() => {
    load();
  }, [load]);

  const remove = async (c: CaptureFile) => {
    await api.deleteMedia(c.path).catch(() => {});
    setOpen(null);
    load();
    onChanged();
  };

  // agrupa por dia
  const groups = useMemo(() => {
    const map = new Map<string, { item: CaptureFile; index: number }[]>();
    items?.forEach((item, index) => {
      const day = new Date(item.time).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
      map.set(day, [...(map.get(day) ?? []), { item, index }]);
    });
    return [...map];
  }, [items]);

  const lensLabel = (c: CaptureFile) => {
    const cam = cameras.find((x) => x.id === c.cameraId);
    return c.lens === 'full' ? '' : (cam?.lensNames[c.lens] ?? c.lens);
  };

  return (
    <div className="space-y-4">
      <CameraSelect cameras={cameras} value={camera} onChange={setCamera} />
      {items === null ? null : items.length === 0 ? (
        <Empty icon={CameraIcon} text="Nenhuma captura ainda. Abra uma câmera em tela cheia e use “Capturar” (ou a tecla P)." />
      ) : (
        groups.map(([day, list]) => (
          <section key={day}>
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">{day}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {list.map(({ item, index }) => (
                <button
                  key={item.path}
                  onClick={() => setOpen(index)}
                  className="group relative aspect-video overflow-hidden rounded-lg bg-black ring-1 ring-white/10 hover:ring-emerald-500/50"
                >
                  <img src={mediaUrl(item.path)} loading="lazy" alt="" className="h-full w-full object-cover transition group-hover:scale-105" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1 text-left text-[10px] text-zinc-300">
                    {camName(item.cameraId)}
                    {lensLabel(item) && ` · ${lensLabel(item)}`} · {time(item.time)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {open !== null && items?.[open] && (
        <Lightbox
          item={items[open]}
          label={`${camName(items[open].cameraId)}${lensLabel(items[open]) ? ` · ${lensLabel(items[open])}` : ''} · ${new Date(items[open].time).toLocaleString('pt-BR')}`}
          onPrev={open > 0 ? () => setOpen(open - 1) : undefined}
          onNext={open < items.length - 1 ? () => setOpen(open + 1) : undefined}
          onDelete={() => remove(items[open])}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Lightbox({
  item,
  label,
  onPrev,
  onNext,
  onDelete,
  onClose,
}: {
  item: CaptureFile;
  label: string;
  onPrev?: () => void;
  onNext?: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEscape(onClose);
  useEffect(() => {
    setConfirm(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onPrev, onNext]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur" onMouseDown={onClose}>
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3" onMouseDown={(e) => e.stopPropagation()}>
        <ImageIcon className="h-4 w-4 text-zinc-500" />
        <span className="text-sm">{label}</span>
        <span className="font-mono text-[11px] text-zinc-500">{formatBytes(item.bytes)}</span>
        <div className="ml-auto flex items-center gap-1">
          <a href={mediaUrl(item.path)} download className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10">
            <Download className="h-4 w-4" />
            Baixar
          </a>
          {confirm ? (
            <>
              <button onClick={onDelete} className="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/30">
                Apagar mesmo
              </button>
              <button onClick={() => setConfirm(false)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/10">
                Não
              </button>
            </>
          ) : (
            <button onClick={() => setConfirm(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-red-400/80 hover:bg-red-500/10 hover:text-red-300">
              <Trash2 className="h-4 w-4" />
              Apagar
            </button>
          )}
          <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4" onMouseDown={(e) => e.stopPropagation()}>
        <img src={mediaUrl(item.path)} alt="" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        {onPrev && (
          <button onClick={onPrev} className="absolute left-4 rounded-full bg-black/60 p-2 text-zinc-300 ring-1 ring-white/10 hover:text-white">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {onNext && (
          <button onClick={onNext} className="absolute right-4 rounded-full bg-black/60 p-2 text-zinc-300 ring-1 ring-white/10 hover:text-white">
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- comuns

function CameraSelect({ cameras, value, onChange }: { cameras: Camera[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex w-fit items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-sm">
      <CameraIcon className="h-4 w-4 text-zinc-500" />
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent outline-none">
        <option value="" className="bg-zinc-900">
          Todas as câmeras
        </option>
        {cameras.map((c) => (
          <option key={c.id} value={c.id} className="bg-zinc-900">
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Empty({ icon: Icon, text }: { icon: typeof Film; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">
      <Icon className="h-6 w-6 text-zinc-600" />
      <p className="max-w-md">{text}</p>
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}
