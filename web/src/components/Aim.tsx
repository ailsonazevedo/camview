import { Crosshair, FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type AimContext, aimFromFixed, calibrate, centerOn, locatePtzInFixed } from '../lib/aim';
import { api, type View } from '../lib/api';
import type { Match } from '../lib/vision';

type Mode = 'center' | 'fixed' | null;

/**
 * Mira por clique para a visualização aberta:
 *  - lente móvel (ou câmera PTZ de uma lente): clique centraliza o ponto;
 *  - lente fixa de uma câmera de duas lentes (experimental): clique aponta a móvel.
 *
 * Começa desligada: só responde a cliques (e só procura a lente móvel na
 * imagem) depois que a pessoa ativa pelo botão "Mira".
 */
export function useAim(view: View, getVideo: () => HTMLVideoElement | null, onCalibrated: () => void, enabled: boolean) {
  const cam = view.camera;
  const dual = cam.lenses === 'dual';
  const available: Mode = cam.ptz !== true ? null : view.ptz ? 'center' : dual ? 'fixed' : null;
  const mode: Mode = enabled ? available : null;
  const cal = cam.ptzCalibration;

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [marker, setMarker] = useState<{ x: number; y: number; key: number } | null>(null);
  const [ptzRect, setPtzRect] = useState<Match | null>(null);
  const busyRef = useRef(false);

  const ctx = useCallback(
    (): AimContext => ({
      camera: cam,
      video: getVideo,
      ptzCrop: dual ? cam.ptzLens : null,
      onProgress: (msg) => setBusy(msg),
    }),
    [cam, dual, getVideo],
  );

  const run = useCallback(async (fn: () => Promise<void>, doneText?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setMessage(null);
    setBusy('Movendo…');
    try {
      await fn();
      if (doneText) setMessage({ kind: 'info', text: doneText });
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, []);

  const runCalibration = () =>
    run(async () => {
      const result = await calibrate(ctx());
      await api.update(cam.id, { ptzCalibration: result });
      onCalibrated();
      if (dual && result.scale === null) {
        throw new Error(
          'Mira calibrada para a lente móvel. Não encontrei a imagem móvel dentro da fixa, então o clique na fixa ficará indisponível — aponte a móvel para uma área que a fixa também vê e recalibre.',
        );
      }
    }, 'Mira calibrada. Clique na imagem para apontar.');

  const onPointClick = useCallback(
    (x: number, y: number) => {
      if (!mode || busyRef.current) return;
      setMarker({ x, y, key: Date.now() });
      if (!cal) {
        setMessage({ kind: 'error', text: 'Calibre a mira primeiro (botão “Calibrar mira”).' });
        return;
      }
      if (mode === 'center') run(() => centerOn(ctx(), cal, x, y));
      else run(() => aimFromFixed(ctx(), cal, x, y));
    },
    [mode, cal, ctx, run],
  );

  // na lente fixa: mostra onde a lente móvel está olhando
  useEffect(() => {
    setPtzRect(null);
    if (mode !== 'fixed' || !cal?.scale) return;
    let alive = true;
    const tick = async () => {
      if (busyRef.current) return;
      const m = await locatePtzInFixed(ctx(), cal).catch(() => null);
      if (alive) setPtzRect(m);
    };
    const id = setInterval(tick, 2000);
    tick();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mode, cal, ctx]);

  useEffect(() => {
    setMessage(null);
    setMarker(null);
  }, [view.key]);

  const overlay = (
    <>
      {ptzRect && (
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-emerald-400/90 shadow-[0_0_0_9999px_rgb(0_0_0/0.15)] transition-all duration-700"
          style={{ left: `${ptzRect.x * 100}%`, top: `${ptzRect.y * 100}%`, width: `${ptzRect.w * 100}%`, height: `${ptzRect.h * 100}%` }}
        >
          <span className="absolute -top-5 left-0 rounded-sm bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wide whitespace-nowrap text-zinc-950 uppercase">
            Lente móvel
          </span>
        </div>
      )}
      {marker && <span key={marker.key} className="cv-click-marker" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }} />}
    </>
  );

  const panel = mode && (
    <div className="w-[208px] rounded-2xl border border-white/10 bg-zinc-950/80 p-3 text-[11px] shadow-2xl shadow-black/60 backdrop-blur-xl">
      <div className="flex items-center gap-1.5 font-medium tracking-wider text-zinc-400 uppercase">
        <Crosshair className="h-3.5 w-3.5 text-emerald-400" />
        Mira por clique
        {mode === 'fixed' && (
          <span className="ml-auto flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-300 normal-case ring-1 ring-amber-500/30">
            <FlaskConical className="h-2.5 w-2.5" />
            beta
          </span>
        )}
      </div>
      <p className="mt-2 leading-relaxed text-zinc-400">
        {!cal
          ? 'Calibre uma vez: a lente móvel faz pequenos movimentos e volta para onde estava (~15s).'
          : mode === 'center'
            ? 'Clique em qualquer ponto da imagem para centralizá-lo.'
            : cal.scale
              ? 'Clique na imagem fixa para apontar a lente móvel para lá.'
              : 'A calibração não achou a lente móvel dentro da fixa. Recalibre com a móvel apontada para a área da fixa.'}
      </p>
      {busy ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-2 text-zinc-200">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {busy}
        </div>
      ) : (
        <button
          onClick={runCalibration}
          className={`mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 font-semibold transition ${
            cal ? 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200' : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
          }`}
        >
          {cal ? <RefreshCw className="h-3 w-3" /> : <Crosshair className="h-3.5 w-3.5" />}
          {cal ? 'Recalibrar' : 'Calibrar mira'}
        </button>
      )}
      {message && (
        <p className={`mt-2 rounded-md px-2 py-1.5 leading-relaxed ${message.kind === 'error' ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
          {message.text}
        </p>
      )}
    </div>
  );

  return { available: available !== null, onPointClick: mode ? onPointClick : undefined, overlay: mode ? overlay : null, panel };
}
