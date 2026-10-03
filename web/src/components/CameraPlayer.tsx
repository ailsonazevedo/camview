import { Loader2, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Crop, streamUrl } from '../lib/api';

export type PlayerState = {
  state: 'loading' | 'live' | 'error';
  mode?: string;
  error?: string;
  width?: number;
  height?: number;
};

export type PlayerElement = HTMLElement & { src: string; video?: HTMLVideoElement };

interface Props {
  stream: string;
  /** Metade do quadro a mostrar (câmeras de duas lentes). */
  crop?: Crop;
  /** Controles nativos e áudio liberado. */
  controls?: boolean;
  fit?: 'contain' | 'cover';
  onStatus?: (s: PlayerState) => void;
  /** Dá acesso ao <camview-player> (e ao <video> dentro dele). */
  onElement?: (el: PlayerElement | null) => void;
  /**
   * Clique na imagem com coordenadas em frações (0–1) da imagem visível.
   * Liga o modo "caixa": o vídeo ocupa uma caixa com a proporção exata da
   * imagem, para o clique bater com o pixel certo.
   */
  onPointClick?: (x: number, y: number) => void;
  /** Camadas desenhadas por cima da imagem, na mesma caixa (coordenadas em %). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Envolve o web component <camview-player> (go2rtc). O elemento é criado
 * imperativamente para que os atributos existam antes do connectedCallback.
 */
export function CameraPlayer({ stream, crop = null, controls = false, fit = 'contain', onStatus, onElement, onPointClick, children, className = '' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PlayerState>({ state: 'loading' });
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onElementRef = useRef(onElement);
  onElementRef.current = onElement;
  const boxed = Boolean(crop || onPointClick || children);

  useEffect(() => {
    const host = hostRef.current!;
    const el = document.createElement('camview-player') as PlayerElement;
    if (controls && !onPointClick) el.setAttribute('controls', '');
    if (crop) el.setAttribute('crop', crop);
    el.setAttribute('fit', boxed && !crop ? 'fill' : fit);
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<PlayerState>).detail;
      setStatus(detail);
      onStatusRef.current?.(detail);
    };
    el.addEventListener('cv-status', handler);
    host.appendChild(el);
    el.src = streamUrl(stream);
    onElementRef.current?.(el);
    return () => {
      el.removeEventListener('cv-status', handler);
      el.remove();
      onElementRef.current?.(null);
    };
  }, [stream, crop, controls, fit, boxed, onPointClick === undefined]);

  const overlay = status.state !== 'live' && (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-zinc-500">
      {status.state === 'loading' ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          <span className="tracking-wide uppercase">Conectando</span>
        </>
      ) : (
        <>
          <VideoOff className="h-6 w-6 text-red-400/80" />
          <span className="font-medium tracking-wide text-red-300/90 uppercase">Sem sinal</span>
          <span className="line-clamp-2 max-w-xs text-zinc-500">{status.error}</span>
        </>
      )}
    </div>
  );

  if (boxed) {
    // proporção da imagem visível (metade do quadro quando recortada)
    const w = status.width || 16;
    const h = status.height ? (crop ? status.height / 2 : status.height) : 9;
    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onPointClick) return;
      const r = e.currentTarget.getBoundingClientRect();
      onPointClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    return (
      <div className={`cv-fit relative h-full w-full bg-black ${className}`}>
        <div className="cv-fit-box relative" style={{ '--ar': w / h } as React.CSSProperties}>
          <div ref={hostRef} className="h-full w-full" />
          <div className={`absolute inset-0 ${onPointClick ? 'cursor-crosshair' : 'pointer-events-none'}`} onClick={handleClick}>
            {children}
          </div>
        </div>
        {overlay}
      </div>
    );
  }
  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      <div ref={hostRef} className="h-full w-full" />
      {overlay}
    </div>
  );
}
