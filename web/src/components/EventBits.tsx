import { ImageOff, X } from 'lucide-react';
import { useState } from 'react';
import { type Camera, type CameraEvent, mediaUrl } from '../lib/api';
import { EVENT_STYLE, eventLabel } from '../lib/events';

/** Metade da foto (câmeras de duas lentes mandam as duas empilhadas). */
function HalfImage({ src, half, onError, className = '' }: { src: string; half: 'top' | 'bottom'; onError: () => void; className?: string }) {
  return (
    // sem "relative" aqui: quem usa decide o posicionamento (o quadrinho é absolute)
    <div className={`aspect-video overflow-hidden bg-black ${className}`}>
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={onError}
        className="absolute inset-x-0 top-0 h-[200%] w-full object-fill"
        style={{ transform: half === 'bottom' ? 'translateY(-50%)' : undefined }}
      />
    </div>
  );
}

/**
 * Foto do evento. Em câmeras de duas lentes, por padrão mostra a lente
 * móvel — ela segue o alvo sozinha (rastreamento da câmera), então é onde a
 * pessoa aparece de perto — com a fixa num quadrinho no canto (`pip`).
 */
export function EventImage({
  event,
  camera,
  lens,
  pip = false,
  className = '',
}: {
  event: CameraEvent;
  camera?: Camera;
  lens?: 'top' | 'bottom' | 'full';
  pip?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dual = camera?.lenses === 'dual';
  const ptzHalf = camera?.ptzLens ?? 'bottom';
  const show = lens ?? (dual ? ptzHalf : 'full');

  if (!event.snapshot || failed) {
    return (
      <div className={`flex aspect-video items-center justify-center bg-zinc-900 text-zinc-600 ${className}`}>
        <ImageOff className="h-5 w-5" />
      </div>
    );
  }
  const src = mediaUrl(event.snapshot);
  if (show === 'full' || !dual) {
    return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`aspect-video object-cover ${className}`} />;
  }
  const other = show === 'top' ? 'bottom' : 'top';
  return (
    <div className={`relative ${className}`}>
      <HalfImage src={src} half={show} onError={() => setFailed(true)} className="relative h-full w-full" />
      {pip && (
        <HalfImage
          src={src}
          half={other}
          onError={() => {}}
          className="absolute top-1.5 right-1.5 w-[34%] rounded ring-1 ring-white/30 shadow-lg"
        />
      )}
    </div>
  );
}

export function EventTypeBadge({ event, compact = false }: { event: Pick<CameraEvent, 'type' | 'raw'>; compact?: boolean }) {
  const st = EVENT_STYLE[event.type];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${st.bg} ${st.text} ${st.ring}`}>
      <st.icon className="h-3 w-3" />
      {!compact && eventLabel(event)}
    </span>
  );
}

export interface ToastItem {
  event: CameraEvent;
  key: string;
}

/** Avisos no canto da tela quando a câmera detecta algo (somem sozinhos). */
export function EventToasts({
  items,
  cameras,
  onOpen,
  onDismiss,
}: {
  items: ToastItem[];
  cameras: Camera[];
  onOpen: (e: CameraEvent) => void;
  onDismiss: (key: string) => void;
}) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2 max-sm:right-2 max-sm:left-2 max-sm:w-auto">
      {items.map(({ event, key }) => {
        const cam = cameras.find((c) => c.id === event.cameraId);
        const st = EVENT_STYLE[event.type];
        return (
          <div
            key={key}
            className={`cv-toast-in pointer-events-auto flex overflow-hidden rounded-xl border border-white/10 bg-zinc-950/95 shadow-2xl shadow-black ring-1 backdrop-blur-xl ${st.ring}`}
          >
            <button onClick={() => onOpen(event)} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left">
              <EventImage event={event} camera={cam} className="w-24 shrink-0 overflow-hidden rounded-lg" />
              <div className="min-w-0">
                <div className={`flex items-center gap-1.5 text-sm font-semibold ${st.text}`}>
                  <span className={`h-2 w-2 animate-pulse rounded-full ${st.dot}`} />
                  {eventLabel(event)}
                </div>
                <div className="truncate text-xs text-zinc-300">{cam?.name ?? event.cameraId}</div>
                <div className="font-mono text-[11px] text-zinc-500">{new Date(event.start).toLocaleTimeString('pt-BR')}</div>
              </div>
            </button>
            <button onClick={() => onDismiss(key)} className="self-start p-2 text-zinc-500 hover:text-zinc-200" title="Dispensar">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
