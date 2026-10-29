import { Check, ChevronDown, House, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Camera, Home } from '../lib/api';

interface Props {
  homes: Home[];
  /** Todas as câmeras (para contar por casa). */
  cameras: Camera[];
  reachable: Record<string, boolean>;
  value: Home;
  onChange: (id: string) => void;
  onManage: () => void;
}

/** Seletor de casa no cabeçalho: o painel inteiro mostra só as câmeras da casa escolhida. */
export function HomeSwitcher({ homes, cameras, reachable, value, onChange, onManage }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Trocar de casa"
        className={`flex max-w-[200px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-medium transition ${
          open ? 'border-white/15 bg-white/[0.07]' : 'border-white/10 hover:bg-white/[0.04]'
        }`}
      >
        <House className="h-4 w-4 shrink-0 text-emerald-400" />
        <span className="truncate">{value.name}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="menu" className="absolute top-full left-0 z-50 mt-1.5 w-64 rounded-xl border border-white/10 bg-zinc-900/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
          <div className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold tracking-widest text-zinc-500 uppercase">Casas</div>
          {homes.map((h) => {
            const cams = cameras.filter((c) => c.homeId === h.id);
            const online = cams.filter((c) => reachable[c.id]).length;
            const active = h.id === value.id;
            return (
              <button
                key={h.id}
                role="menuitemradio"
                aria-checked={active}
                onClick={pick(() => onChange(h.id))}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                  active ? 'bg-white/[0.07] text-white' : 'text-zinc-300 hover:bg-white/[0.04] hover:text-white'
                }`}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cams.length === 0 ? 'bg-zinc-600' : online > 0 ? 'bg-emerald-400' : 'bg-red-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{h.name}</span>
                  <span className="block text-[11px] text-zinc-500">
                    {cams.length === 0 ? 'sem câmeras' : `${online}/${cams.length} online`}
                  </span>
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-emerald-400" />}
              </button>
            );
          })}
          <div className="my-1.5 border-t border-white/5" />
          <button
            role="menuitem"
            onClick={pick(onManage)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-white"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Gerenciar casas
          </button>
        </div>
      )}
    </div>
  );
}
