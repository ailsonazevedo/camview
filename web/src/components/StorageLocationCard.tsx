import { AlertTriangle, CheckCircle2, FolderOpen, HardDrive, Loader2, Lock, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, type StorageLocation } from '../lib/api';

/**
 * Onde as gravações, capturas e fotos de eventos são salvas — e o botão para
 * trocar (com opção de mover o que já existe).
 */
export function StorageLocationCard({ retentionGB, onChanged }: { retentionGB: number; onChanged: () => void }) {
  const [loc, setLoc] = useState<StorageLocation | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => api.storageLocation().then(setLoc).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  // acompanha a mudança dos arquivos
  const moving = loc?.move?.state === 'running';
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, [moving, load]);
  useEffect(() => {
    if (loc?.move?.state === 'done') onChanged();
  }, [loc?.move?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loc) return null;
  const lowSpace = loc.available && loc.freeBytes !== undefined && loc.freeBytes < retentionGB * 1024 ** 3;
  const move = loc.move;

  return (
    <div className={`rounded-xl border p-4 ${loc.available ? 'border-white/10 bg-white/[0.02]' : 'border-red-500/30 bg-red-500/[0.06]'}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ${loc.available ? 'bg-white/5 ring-white/10' : 'bg-red-500/10 ring-red-500/30'}`}>
          <HardDrive className={`h-4 w-4 ${loc.available ? 'text-zinc-300' : 'text-red-300'}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Local de armazenamento
            {loc.isDefault && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400 uppercase ring-1 ring-white/10">padrão</span>}
            {loc.available ? (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                disponível
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-red-300">
                <AlertTriangle className="h-3 w-3" />
                indisponível
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-xs break-all text-zinc-400">{loc.dir}</div>
          {loc.available && loc.freeBytes !== undefined && (
            <div className="mt-1 text-xs text-zinc-500">
              {formatBytes(loc.freeBytes)} livres de {formatBytes(loc.totalBytes ?? 0)} neste disco
            </div>
          )}
          {!loc.available && <div className="mt-1 text-xs text-red-300">{loc.reason} Gravações, capturas e eventos ficam pausados até a pasta voltar.</div>}
          {lowSpace && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              O disco tem menos espaço livre que o limite das gravações ({retentionGB} GB). Diminua o limite ou use um HD externo.
            </div>
          )}
        </div>
        {loc.locked ? (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500" title="Definido pela variável de ambiente CAMVIEW_MEDIA_DIR">
            <Lock className="h-3.5 w-3.5" />
            CAMVIEW_MEDIA_DIR
          </span>
        ) : (
          !editing && (
            <button
              onClick={() => setEditing(true)}
              disabled={moving}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/5 disabled:opacity-50"
            >
              <FolderOpen className="h-4 w-4" />
              Alterar local
            </button>
          )
        )}
      </div>

      {move && (move.state === 'running' || Date.now() - new Date(move.finishedAt ?? 0).getTime() < 60_000) && <MoveProgress move={move} />}

      {editing && (
        <ChangeForm
          current={loc.dir}
          onCancel={() => setEditing(false)}
          onDone={(next) => {
            setLoc(next);
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function MoveProgress({ move }: { move: NonNullable<StorageLocation['move']> }) {
  const pct = move.totalBytes ? Math.round((move.movedBytes / move.totalBytes) * 100) : move.state === 'done' ? 100 : 0;
  return (
    <div className="mt-3 rounded-lg bg-black/30 p-3 text-xs">
      <div className="flex items-center gap-2 text-zinc-300">
        {move.state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : move.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <AlertTriangle className="h-3.5 w-3.5 text-red-300" />}
        {move.state === 'running' ? 'Movendo arquivos para o novo local…' : move.state === 'done' ? 'Arquivos movidos.' : `Falha ao mover: ${move.error}`}
        <span className="ml-auto font-mono text-zinc-500">
          {move.movedFiles}/{move.totalFiles} · {formatBytes(move.movedBytes)} de {formatBytes(move.totalBytes)}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full transition-all ${move.state === 'error' ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 truncate font-mono text-[10px] text-zinc-600">
        {move.from} → {move.to}
      </div>
    </div>
  );
}

function ChangeForm({ current, onCancel, onDone }: { current: string; onCancel: () => void; onDone: (loc: StorageLocation) => void }) {
  const [dir, setDir] = useState('');
  const [move, setMove] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<{ label: string; dir: string; freeBytes?: number }[]>([]);

  useEffect(() => {
    api.storageSuggestions().then(setSuggestions).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onDone(await api.setStorageLocation(dir, move));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 border-t border-white/5 pt-4">
      <div className="flex flex-wrap gap-2">
        {suggestions
          .filter((s) => s.dir !== current)
          .map((s) => (
            <button
              key={s.dir}
              onClick={() => setDir(s.dir)}
              className={`rounded-lg border px-3 py-1.5 text-left text-xs transition ${dir === s.dir ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 hover:bg-white/5'}`}
            >
              <div className="font-medium text-zinc-200">{s.label}</div>
              <div className="font-mono text-[10px] text-zinc-500">
                {s.dir}
                {s.freeBytes !== undefined && ` · ${formatBytes(s.freeBytes)} livres`}
              </div>
            </button>
          ))}
      </div>
      <input
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        placeholder="/Volumes/MeuHD/CamView  ou  ~/Movies/CamView"
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
        autoFocus
      />
      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} className="mt-0.5 h-4 w-4 accent-emerald-500" />
        <span>
          <span className="text-zinc-200">Mover os arquivos existentes para o novo local</span>
          <span className="block text-[11px] text-zinc-500">
            Se desmarcar, os arquivos antigos ficam onde estão e deixam de aparecer no painel até você voltar para aquele local.
          </span>
        </span>
      </label>
      <p className="text-[11px] text-zinc-500">
        HD externo: conecte o disco e escolha uma pasta nele (ex.: <span className="font-mono">/Volumes/NomeDoHD/CamView</span>). A pasta é criada se não existir. Se o disco for
        desconectado, o painel avisa e pausa as gravações — nada é salvo no disco do Mac por engano.
      </p>
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/20">
          <X className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/5">
          Cancelar
        </button>
        <button
          onClick={save}
          disabled={!dir.trim() || saving}
          className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Usar este local
        </button>
      </div>
    </div>
  );
}
