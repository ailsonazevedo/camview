import { Activity, type LucideIcon, ShieldAlert, User } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { CameraEvent, EventType } from './api';

const RAW_LABELS: Record<string, string> = {
  VideoBlind: 'Câmera obstruída',
  VideoLoss: 'Perda de vídeo',
  LocalAlarm: 'Alarme',
  StorageFailure: 'Falha no armazenamento',
  StorageLowSpace: 'Armazenamento cheio',
};

export function eventLabel(e: Pick<CameraEvent, 'type' | 'raw'>) {
  if (e.type === 'human') return 'Pessoa detectada';
  if (e.type === 'motion') return 'Movimento detectado';
  const raw = e.raw[0] ?? '';
  return RAW_LABELS[raw] ?? `Alarme: ${raw}`;
}

export const EVENT_STYLE: Record<EventType, { icon: LucideIcon; text: string; bg: string; ring: string; dot: string }> = {
  human: { icon: User, text: 'text-orange-300', bg: 'bg-orange-500/15', ring: 'ring-orange-500/40', dot: 'bg-orange-400' },
  motion: { icon: Activity, text: 'text-sky-300', bg: 'bg-sky-500/15', ring: 'ring-sky-500/40', dot: 'bg-sky-400' },
  other: { icon: ShieldAlert, text: 'text-zinc-300', bg: 'bg-white/10', ring: 'ring-white/20', dot: 'bg-zinc-400' },
};

/**
 * Assina o canal de avisos em tempo real do servidor (SSE). O EventSource
 * reconecta sozinho se o servidor reiniciar.
 */
export function useEventStream(onMessage: (kind: 'new' | 'update', event: CameraEvent) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    const make = (kind: 'new' | 'update') => (ev: MessageEvent) => {
      try {
        handler.current(kind, JSON.parse(ev.data));
      } catch {}
    };
    es.addEventListener('new', make('new'));
    es.addEventListener('update', make('update'));
    return () => es.close();
  }, []);
}

// ---------- notificações do navegador (opcionais) ----------

const NOTIFY_KEY = 'camview.notify';

export function notificationsEnabled() {
  try {
    return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export async function enableNotifications() {
  if (!('Notification' in window)) throw new Error('Este navegador não suporta notificações.');
  if (!window.isSecureContext) throw new Error('Notificações só funcionam em https ou em localhost.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permissão de notificação negada no navegador.');
  try {
    localStorage.setItem(NOTIFY_KEY, '1');
  } catch {}
}

export function disableNotifications() {
  try {
    localStorage.removeItem(NOTIFY_KEY);
  } catch {}
}

export function showSystemNotification(title: string, body: string, image: string | null, onClick: () => void) {
  if (!notificationsEnabled()) return;
  try {
    const n = new Notification(title, { body, icon: image ?? undefined, tag: `${title}-${body}` });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {}
}
