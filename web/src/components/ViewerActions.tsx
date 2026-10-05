import { Camera as CameraIcon, Check, Circle, Crosshair, Loader2, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Crop, formatDuration, type RecordingStatus } from '../lib/api';
import { takeCapture } from '../lib/capture';

const btn = 'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition disabled:opacity-50';

/** Foto do quadro atual (resolução real, só a lente visível). */
export function CaptureButton({
  cameraId,
  crop,
  getVideo,
  onCaptured,
}: {
  cameraId: string;
  crop: Crop;
  getVideo: () => HTMLVideoElement | null;
  onCaptured: (ok: boolean, message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const capture = async () => {
    const video = getVideo();
    if (!video || busy) return;
    setBusy(true);
    try {
      await takeCapture(video, cameraId, crop);
      onCaptured(true, 'Captura salva na galeria');
    } catch (err) {
      onCaptured(false, (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // atalho: tecla P (de "photo")
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'p' || e.key === 'P') && !(e.target as HTMLElement)?.closest('input,select,textarea')) capture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <button onClick={capture} disabled={busy} title="Capturar imagem (P)" className={`${btn} text-zinc-300 hover:bg-white/10 hover:text-white`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CameraIcon className="h-3.5 w-3.5" />}
      <span className="max-md:hidden">Capturar</span>
    </button>
  );
}

/** Liga/desliga a gravação manual; mostra o tempo enquanto grava. */
export function RecordButton({
  cameraId,
  quality,
  status,
  onChange,
}: {
  cameraId: string;
  quality: 'hd' | 'sd';
  status?: RecordingStatus;
  onChange: (status: Record<string, RecordingStatus>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const manual = status?.kind === 'manual';
  const continuous = status?.kind === 'continuous';

  useEffect(() => {
    if (!status) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.record(cameraId, manual ? 'stop' : 'start', quality));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const elapsed = status ? formatDuration(Date.now() - new Date(status.startedAt).getTime()) : '';

  return (
    <div className="flex items-center gap-1.5">
      {continuous && (
        <span className="flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1 text-[10px] font-bold tracking-wider text-red-300 uppercase ring-1 ring-red-500/20" title="Gravação contínua ligada no cadastro da câmera">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
          Contínua
        </span>
      )}
      <button
        onClick={toggle}
        disabled={busy}
        title={error ?? (manual ? 'Parar gravação' : `Gravar (${quality.toUpperCase()})`)}
        className={`${btn} ${manual ? 'bg-red-600 text-white shadow-lg shadow-red-600/30 hover:bg-red-500' : 'text-zinc-300 hover:bg-white/10 hover:text-white'} ${error ? 'ring-1 ring-red-500/60' : ''}`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : manual ? (
          <Square className="h-3 w-3 fill-current" />
        ) : (
          <Circle className="h-3.5 w-3.5 fill-red-500 text-red-500" />
        )}
        {manual ? <span className="font-mono tabular-nums">{elapsed}</span> : <span className="max-md:hidden">Gravar</span>}
      </button>
    </div>
  );
}

/** Ativa/desativa a mira por clique (começa desligada). */
export function AimToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={enabled ? 'Desativar mira por clique' : 'Ativar mira por clique'}
      className={`${btn} ${enabled ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40' : 'text-zinc-300 hover:bg-white/10 hover:text-white'}`}
    >
      {enabled ? <Check className="h-3.5 w-3.5" /> : <Crosshair className="h-3.5 w-3.5" />}
      <span className="max-md:hidden">Mira</span>
    </button>
  );
}
