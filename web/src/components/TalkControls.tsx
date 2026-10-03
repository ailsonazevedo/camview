import { Loader2, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TalkSession, type TalkState } from '../lib/talk';

interface Props {
  /** Stream "<id>_talk" do go2rtc. */
  talkStream: string;
  /** Liga/desliga o som da câmera no vídeo principal. */
  listening: boolean;
  onListeningChange: (on: boolean) => void;
}

/**
 * Interfone: "Ouvir" libera o áudio da câmera; "Falar" abre o microfone e
 * manda a voz para o alto-falante dela. Clique para começar e para encerrar.
 */
export function TalkControls({ talkStream, listening, onListeningChange }: Props) {
  const [state, setState] = useState<TalkState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const session = useRef<TalkSession | null>(null);

  const stop = () => {
    session.current?.stop();
    session.current = null;
  };

  const toggle = () => {
    if (session.current) return stop();
    setError(null);
    const s = new TalkSession(talkStream, (st, err) => {
      setState(st);
      if (err) setError(err);
      if (st === 'error' || st === 'idle') {
        if (session.current === s) session.current = null;
      }
    });
    session.current = s;
    s.start();
    // falar normalmente vem junto com ouvir a resposta
    if (!listening) onListeningChange(true);
  };

  // medidor do microfone
  useEffect(() => {
    if (state !== 'live') {
      setLevel(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      setLevel(session.current?.level() ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  // encerra ao trocar de câmera / fechar
  useEffect(() => stop, [talkStream]);

  const talking = state === 'live';

  return (
    <div className="flex flex-col items-start gap-2">
      {error && (
        <div className="max-w-xs rounded-lg bg-red-950/90 px-3 py-2 text-xs text-red-200 shadow-xl ring-1 ring-red-500/30 backdrop-blur">{error}</div>
      )}
      <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-zinc-950/80 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <button
          onClick={() => onListeningChange(!listening)}
          title={listening ? 'Silenciar a câmera' : 'Ouvir a câmera'}
          className={`flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium transition ${
            listening ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          }`}
        >
          {listening ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          <span className="max-sm:hidden">{listening ? 'Ouvindo' : 'Ouvir'}</span>
        </button>

        <button
          onClick={toggle}
          title={talking ? 'Parar de falar' : 'Falar pela câmera'}
          className={`relative flex h-11 items-center gap-2 overflow-hidden rounded-xl px-4 text-sm font-semibold transition ${
            talking
              ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
              : state === 'connecting'
                ? 'bg-white/10 text-zinc-300'
                : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
          }`}
        >
          {/* nível do microfone */}
          {talking && <span className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />}
          <span className="relative flex items-center gap-2">
            {state === 'connecting' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : talking ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
            {state === 'connecting' ? 'Conectando…' : talking ? 'Encerrar' : 'Falar'}
          </span>
        </button>
        {talking && (
          <span className="flex items-center gap-1.5 pr-2 text-[11px] font-semibold tracking-wider text-red-300 uppercase">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
            No ar
          </span>
        )}
      </div>
    </div>
  );
}
