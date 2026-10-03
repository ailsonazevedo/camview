import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, Gauge, Move } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PTZ_DIRECTIONS, type PtzDirection } from '../lib/api';

const ICONS: Record<PtzDirection, typeof ArrowUp> = {
  DirectionLeftUp: ArrowUpLeft,
  DirectionUp: ArrowUp,
  DirectionRightUp: ArrowUpRight,
  DirectionLeft: ArrowLeft,
  DirectionRight: ArrowRight,
  DirectionLeftDown: ArrowDownLeft,
  DirectionDown: ArrowDown,
  DirectionRightDown: ArrowDownRight,
};

const KEYS: Record<string, PtzDirection> = {
  ArrowUp: 'DirectionUp',
  ArrowDown: 'DirectionDown',
  ArrowLeft: 'DirectionLeft',
  ArrowRight: 'DirectionRight',
};

function loadSpeed() {
  try {
    const v = Number(localStorage.getItem('camview.ptzSpeed'));
    return v >= 1 && v <= 8 ? v : 4;
  } catch {
    return 4;
  }
}

/**
 * Joystick PTZ: segure para mover, solte para parar. Também responde às setas
 * do teclado. O servidor para o movimento sozinho após 8s se o "stop" se perder.
 */
export function PtzPad({ cameraId, keyboard = true }: { cameraId: string; keyboard?: boolean }) {
  const [active, setActive] = useState<PtzDirection | null>(null);
  const [speed, setSpeed] = useState(loadSpeed);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef<PtzDirection | null>(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const start = useCallback(
    (dir: PtzDirection) => {
      if (activeRef.current === dir) return;
      activeRef.current = dir;
      setActive(dir);
      setError(null);
      api.ptz(cameraId, { command: dir, action: 'start', speed: speedRef.current }).catch((e: Error) => setError(e.message));
    },
    [cameraId],
  );

  const stop = useCallback(() => {
    const dir = activeRef.current;
    if (!dir) return;
    activeRef.current = null;
    setActive(null);
    api.ptz(cameraId, { command: dir, action: 'stop', speed: speedRef.current }).catch((e: Error) => setError(e.message));
  }, [cameraId]);

  useEffect(() => {
    try {
      localStorage.setItem('camview.ptzSpeed', String(speed));
    } catch {}
  }, [speed]);

  // setas do teclado + parar ao perder o foco da janela
  useEffect(() => {
    if (!keyboard) return;
    const down = (e: KeyboardEvent) => {
      const dir = KEYS[e.key];
      if (!dir || (e.target as HTMLElement)?.closest('input,select,textarea')) return;
      e.preventDefault();
      if (!e.repeat) start(dir);
    };
    const up = (e: KeyboardEvent) => {
      if (KEYS[e.key] && activeRef.current === KEYS[e.key]) stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
    };
  }, [keyboard, start, stop]);

  // garante parada ao desmontar
  useEffect(() => stop, [stop]);

  return (
    <div className="w-[208px] select-none rounded-2xl border border-white/10 bg-zinc-950/80 p-3 shadow-2xl shadow-black/60 backdrop-blur-xl">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">
        <Move className="h-3.5 w-3.5 text-emerald-400" />
        Controle PTZ
        {active && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
      </div>

      <div className="relative mx-auto grid aspect-square w-[184px] grid-cols-3 grid-rows-3 overflow-hidden rounded-full border border-white/10 bg-gradient-to-b from-zinc-800/80 to-zinc-900/80">
        {PTZ_DIRECTIONS.map((dir, i) => {
          if (!dir) {
            return (
              <div key="center" className="flex items-center justify-center">
                <div
                  className={`h-11 w-11 rounded-full border border-white/10 bg-zinc-950 shadow-inner transition ${active ? 'shadow-emerald-500/30 ring-2 ring-emerald-500/40' : ''}`}
                />
              </div>
            );
          }
          const Icon = ICONS[dir];
          const diagonal = dir.length > 'DirectionRight'.length;
          return (
            <button
              key={dir}
              aria-label={dir}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start(dir);
              }}
              onPointerUp={stop}
              onPointerCancel={stop}
              onLostPointerCapture={stop}
              onContextMenu={(e) => e.preventDefault()}
              className={`flex touch-none items-center justify-center transition-colors ${
                active === dir ? 'bg-emerald-500/25 text-emerald-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
              } ${i === 0 ? 'rounded-tl-full' : ''} ${i === 2 ? 'rounded-tr-full' : ''} ${i === 6 ? 'rounded-bl-full' : ''} ${i === 8 ? 'rounded-br-full' : ''}`}
            >
              <Icon className={diagonal ? 'h-4 w-4 opacity-70' : 'h-5 w-5'} />
            </button>
          );
        })}
      </div>

      <label className="mt-3 flex min-w-0 items-center gap-2 text-[11px] text-zinc-400">
        <Gauge className="h-3.5 w-3.5" />
        Velocidade
        <input
          type="range"
          min={1}
          max={8}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="h-1 w-full min-w-0 flex-1 accent-emerald-500"
        />
        <span className="w-3 text-right font-mono text-zinc-300">{speed}</span>
      </label>

      <p className="mt-2 text-center text-[10px] text-zinc-500">Segure para mover · setas do teclado</p>
      {error && <p className="mt-2 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
}
