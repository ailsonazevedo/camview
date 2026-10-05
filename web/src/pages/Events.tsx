import { Bell, BellOff, CalendarDays, Camera as CameraIcon, CheckCheck, ChevronLeft, ChevronRight, Clock, Download, Film, Loader2, Settings2, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EventImage, EventTypeBadge } from '../components/EventBits';
import { api, type Camera, type CameraEvent, type EventType, formatDuration, mediaUrl } from '../lib/api';
import { disableNotifications, EVENT_STYLE, enableNotifications, eventLabel, notificationsEnabled } from '../lib/events';

const PAGE = 60;

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayLabel = (key: string) => {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 864e5).toISOString());
  if (key === today) return 'Hoje';
  if (key === yesterday) return 'Ontem';
  return new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
};
const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR');

interface Props {
  cameras: Camera[];
  /** Eventos que chegaram em tempo real (SSE) — entram no topo da lista. */
  live: CameraEvent[];
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onUnseenChange: (n: number) => void;
}

export function Events({ cameras, live, openId, onOpenChange, onUnseenChange }: Props) {
  const [camera, setCamera] = useState('');
  const [type, setType] = useState<'' | EventType>('');
  const [date, setDate] = useState('');
  const [items, setItems] = useState<CameraEvent[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notify, setNotify] = useState(notificationsEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const camOf = useCallback((id: string) => cameras.find((c) => c.id === id), [cameras]);

  const filter = useMemo(() => ({ camera, type, date }), [camera, type, date]);

  const load = useCallback(async () => {
    const list = await api.events({ ...filter, limit: PAGE }).catch(() => []);
    setItems(list);
    setMore(list.length === PAGE);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.eventsSummary().then((s) => setEnabled(s.enabled)).catch(() => {});
  }, []);

  // eventos em tempo real: insere/atualiza na lista se passam no filtro
  useEffect(() => {
    if (!items || live.length === 0) return;
    setItems((cur) => {
      if (!cur) return cur;
      let next = cur;
      for (const e of live) {
        const matches = (!filter.camera || e.cameraId === filter.camera) && (!filter.type || e.type === filter.type) && (!filter.date || dayKey(e.start) === filter.date);
        const i = next.findIndex((x) => x.id === e.id);
        if (i >= 0) next = next.map((x) => (x.id === e.id ? { ...e, seen: x.seen || e.seen } : x));
        else if (matches) next = [e, ...next];
      }
      return next;
    });
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!items?.length) return;
    setLoadingMore(true);
    const list = await api.events({ ...filter, before: items[items.length - 1].start, limit: PAGE }).catch(() => []);
    setItems([...items, ...list]);
    setMore(list.length === PAGE);
    setLoadingMore(false);
  };

  const markSeen = async (ids: string[] | 'all') => {
    const { unseen } = await api.markSeen(ids);
    onUnseenChange(unseen);
    setItems((cur) => cur?.map((e) => (ids === 'all' || ids.includes(e.id) ? { ...e, seen: true } : e)) ?? cur);
  };

  const open = items?.find((e) => e.id === openId) ?? live.find((e) => e.id === openId);
  useEffect(() => {
    if (open && !open.seen) markSeen([open.id]);
  }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (ids: string[]) => {
    await api.deleteEvents(ids);
    setItems((cur) => cur?.filter((e) => !ids.includes(e.id)) ?? cur);
    setSelecting(null);
    if (openId && ids.includes(openId)) onOpenChange(null);
    api.eventsSummary().then((s) => onUnseenChange(s.unseen)).catch(() => {});
  };

  const toggleNotify = async () => {
    setNotice(null);
    if (notify) {
      disableNotifications();
      setNotify(false);
      return;
    }
    try {
      await enableNotifications();
      setNotify(true);
      setNotice('Notificações ligadas: você será avisado mesmo com o painel em outra aba (enquanto ele estiver aberto).');
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const groups = useMemo(() => {
    const map = new Map<string, CameraEvent[]>();
    for (const e of items ?? []) map.set(dayKey(e.start), [...(map.get(dayKey(e.start)) ?? []), e]);
    return [...map];
  }, [items]);

  const unseenInList = items?.some((e) => !e.seen);
  const flat = items ?? [];
  const openIndex = open ? flat.findIndex((e) => e.id === open.id) : -1;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 lg:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Eventos</h2>
          <p className="text-sm text-zinc-500">Histórico das detecções enviadas pelas câmeras.</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            onClick={toggleNotify}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              notify ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-zinc-300 hover:bg-white/5'
            }`}
          >
            {notify ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            {notify ? 'Notificações ligadas' : 'Ativar notificações'}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 hover:bg-white/5"
            title="Retenção do histórico"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <BellOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Detecções desligadas: nenhum evento novo está sendo registrado. O histórico abaixo continua disponível.{' '}
            <a href="#/configuracoes" className="font-medium underline underline-offset-2 hover:text-amber-100">
              Ligar em Configurações
            </a>
          </span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-300">
          {notice}
          <button onClick={() => setNotice(null)} className="ml-auto text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {showSettings && <RetentionSettings onClose={() => setShowSettings(false)} />}

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-white/10 p-0.5 text-sm">
          {(
            [
              ['', 'Todos'],
              ['human', 'Pessoas'],
              ['motion', 'Movimento'],
              ['other', 'Outros'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setType(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition ${type === id ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}
            >
              {id && <span className={`h-1.5 w-1.5 rounded-full ${EVENT_STYLE[id].dot}`} />}
              {label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-sm">
          <CameraIcon className="h-4 w-4 text-zinc-500" />
          <select value={camera} onChange={(e) => setCamera(e.target.value)} className="bg-transparent outline-none">
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
        <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-sm">
          <CalendarDays className="h-4 w-4 text-zinc-500" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="bg-transparent text-zinc-200 outline-none [color-scheme:dark]" />
          {date && (
            <button onClick={() => setDate('')} className="text-zinc-500 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
        <div className="ml-auto flex gap-2">
          {selecting ? (
            <>
              <span className="self-center text-xs text-zinc-400">{selecting.size} selecionado(s)</span>
              <button
                disabled={selecting.size === 0}
                onClick={() => remove([...selecting])}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/20 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/30 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
                Apagar
              </button>
              <button onClick={() => setSelecting(null)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/5">
                Cancelar
              </button>
            </>
          ) : (
            <>
              {unseenInList && (
                <button onClick={() => markSeen('all')} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5">
                  <CheckCheck className="h-4 w-4" />
                  Marcar todos como vistos
                </button>
              )}
              {flat.length > 0 && (
                <button onClick={() => setSelecting(new Set())} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/5">
                  Selecionar
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {items === null ? null : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">
          <Bell className="h-6 w-6 text-zinc-600" />
          <p className="max-w-md">
            Nenhum evento {type || camera || date ? 'com esses filtros' : 'ainda'}. Quando uma câmera detectar uma pessoa ou movimento, aparece aqui na hora — com foto e um
            clipe do momento.
          </p>
        </div>
      ) : (
        <>
          {groups.map(([day, list]) => (
            <section key={day}>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
                {dayLabel(day)}
                <span className="font-mono text-zinc-600 normal-case">· {list.length}</span>
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((e) => {
                  const cam = camOf(e.cameraId);
                  const selected = selecting?.has(e.id);
                  return (
                    <button
                      key={e.id}
                      onClick={() => {
                        if (selecting) {
                          const next = new Set(selecting);
                          if (next.has(e.id)) next.delete(e.id);
                          else next.add(e.id);
                          setSelecting(next);
                        } else onOpenChange(e.id);
                      }}
                      className={`group relative overflow-hidden rounded-xl border bg-white/[0.02] text-left transition hover:border-white/20 ${
                        selected ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-white/10'
                      }`}
                    >
                      <div className="relative">
                        <EventImage event={e} camera={cam} pip className="w-full" />
                        {e.end === null && (
                          <span className="absolute top-2 left-2 flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-white uppercase">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                            Agora
                          </span>
                        )}
                        {e.clip && (
                          <span className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-zinc-200">
                            <Film className="h-3 w-3" />
                            {e.end ? 'vídeo' : 'gravando'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        {!e.seen && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" title="Novo" />}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <EventTypeBadge event={e} />
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-zinc-400">
                            {cam?.name ?? e.cameraId}
                            <span className="text-zinc-600">·</span>
                            <span className="font-mono">{time(e.start)}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {more && (
            <div className="flex justify-center">
              <button onClick={loadMore} disabled={loadingMore} className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-300 hover:bg-white/5">
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Carregar mais
              </button>
            </div>
          )}
        </>
      )}

      {open && (
        <EventModal
          event={open}
          camera={camOf(open.cameraId)}
          onClose={() => onOpenChange(null)}
          onPrev={openIndex > 0 ? () => onOpenChange(flat[openIndex - 1].id) : undefined}
          onNext={openIndex >= 0 && openIndex < flat.length - 1 ? () => onOpenChange(flat[openIndex + 1].id) : undefined}
          onDelete={() => remove([open.id])}
        />
      )}
    </div>
  );
}

function RetentionSettings({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState<string>('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.storage().then((s) => setDays(String(s.settings.eventsDays))).catch(() => {});
  }, []);
  const save = async () => {
    await api.saveSettings({ eventsDays: Number(days) });
    setSaved(true);
    setTimeout(onClose, 800);
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm">
      <Clock className="h-4 w-4 text-zinc-500" />
      Manter o histórico de eventos por
      <input
        type="number"
        min={1}
        max={365}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        className="w-20 rounded-md border border-white/10 bg-black/40 px-2 py-1 font-mono outline-none focus:border-emerald-500/60"
      />
      dias.
      <span className="text-xs text-zinc-500">Os clipes seguem o limite de espaço das gravações.</span>
      <button onClick={save} className="ml-auto rounded-md bg-emerald-500 px-3 py-1 font-semibold text-zinc-950 hover:bg-emerald-400">
        {saved ? 'Salvo' : 'Salvar'}
      </button>
    </div>
  );
}

function EventModal({
  event,
  camera,
  onClose,
  onPrev,
  onNext,
  onDelete,
}: {
  event: CameraEvent;
  camera?: Camera;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onDelete: () => void;
}) {
  const dual = camera?.lenses === 'dual';
  // abre na lente móvel (segue o alvo); dá para trocar para a fixa ou ver as duas
  const [lens, setLens] = useState<'both' | 'top' | 'bottom'>(dual ? (camera?.ptzLens ?? 'bottom') : 'both');
  const [clipFailed, setClipFailed] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setClipFailed(false);
    setConfirm(false);
  }, [event.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext]);

  const ms = event.end ? new Date(event.end).getTime() - new Date(event.start).getTime() : 0;
  const duration = event.end ? `alarme de ${ms < 1000 ? 'menos de 1s' : formatDuration(ms)}` : 'em andamento';
  const clipUrl = event.clip && !clipFailed ? mediaUrl(event.clip) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 backdrop-blur" onMouseDown={onClose}>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-3" onMouseDown={(e) => e.stopPropagation()}>
        <EventTypeBadge event={event} />
        <div className="min-w-0">
          <div className="text-sm font-semibold">{camera?.name ?? event.cameraId}</div>
          <div className="font-mono text-[11px] text-zinc-500">
            {new Date(event.start).toLocaleString('pt-BR')} · {duration}
          </div>
        </div>
        {dual && camera && (
          <div className="flex rounded-lg border border-white/10 p-0.5 text-xs font-medium">
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
          {event.snapshot && (
            <a href={mediaUrl(event.snapshot)} download className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10">
              <Download className="h-4 w-4" />
              Foto
            </a>
          )}
          {clipUrl && (
            <a href={clipUrl} download className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/10">
              <Download className="h-4 w-4" />
              Vídeo
            </a>
          )}
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
            <button onClick={() => setConfirm(true)} className="rounded-lg p-2 text-zinc-500 hover:bg-red-500/10 hover:text-red-300" title="Apagar evento">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 p-4" onMouseDown={(e) => e.stopPropagation()}>
        {clipUrl ? (
          lens === 'both' ? (
            <video key={clipUrl} src={clipUrl} controls autoPlay muted onError={() => setClipFailed(true)} className="h-full w-full object-contain" />
          ) : (
            <div className="cv-fit h-full w-full">
              <div className="cv-fit-box relative overflow-hidden" style={{ '--ar': 16 / 9 } as React.CSSProperties}>
                <video
                  key={clipUrl}
                  src={clipUrl}
                  controls
                  autoPlay
                  muted
                  onError={() => setClipFailed(true)}
                  className="absolute inset-x-0 top-0 h-[200%] w-full object-fill"
                  style={{ transform: lens === 'bottom' ? 'translateY(-50%)' : undefined }}
                />
              </div>
            </div>
          )
        ) : (
          <div className="cv-fit h-full w-full">
            <div className="cv-fit-box" style={{ '--ar': 16 / 9 } as React.CSSProperties}>
              <EventImage event={event} camera={camera} lens={lens === 'both' ? (dual ? undefined : 'full') : lens} className="h-full w-full rounded-lg" />
            </div>
          </div>
        )}
        {onPrev && (
          <button onClick={onPrev} className="absolute top-1/2 left-6 rounded-full bg-black/60 p-2 text-zinc-300 ring-1 ring-white/10 hover:text-white">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {onNext && (
          <button onClick={onNext} className="absolute top-1/2 right-6 rounded-full bg-black/60 p-2 text-zinc-300 ring-1 ring-white/10 hover:text-white">
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-white/5 px-4 py-2.5 text-xs text-zinc-500" onMouseDown={(e) => e.stopPropagation()}>
        <span>{eventLabel(event)}</span>
        {event.raw.length > 0 && <span className="font-mono">alarme: {event.raw.join(', ')}</span>}
        {!event.clip && <span>Sem clipe (ligue “Gravar clipe” no cadastro da câmera).</span>}
        {event.clip && clipFailed && <span>O clipe foi apagado pelo limite de espaço das gravações.</span>}
        {event.end === null && <span className="text-red-300">O clipe ainda está sendo gravado — abra de novo em alguns segundos para ver até o fim.</span>}
      </div>
    </div>
  );
}
