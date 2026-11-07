// The Shell's toast area: one message at a time, above the router so navigating doesn't hide it.
import { useSyncExternalStore } from 'react';
import { api } from './store.ts';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  /** Set for the Reset toast: Undo puts this batch back. */
  undoBatchId?: string;
}

let current: Toast | undefined;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(toast: Toast | undefined, ms?: number) {
  clearTimeout(timer);
  current = toast;
  if (toast && ms) {
    timer = setTimeout(() => {
      if (current?.id === toast.id) set(undefined);
    }, ms);
  }
  for (const l of listeners) l();
}

export const showToast = (toast: Omit<Toast, 'id'>, ms = 10_000) => set({ ...toast, id: nextId++ }, ms);
export const dismissToast = () => set(undefined);
const plural = (n: number) => `${n} ${n === 1 ? 'Item' : 'Items'}`;

export function showArchived(batchId: string, count: number) {
  showToast({ text: `Archived ${count} shipped ${count === 1 ? 'Item' : 'Items'}.`, kind: 'info', undoBatchId: batchId });
}

async function undo(toast: Toast) {
  try {
    const { itemIds } = await api<{ itemIds: string[] }>('POST', '/api/archive/unarchive', { batchId: toast.undoBatchId });
    showToast({ text: `Put back ${plural(itemIds.length)}.`, kind: 'info' }, 3000);
  } catch (err) {
    showToast({ text: (err as Error).message, kind: 'error' });
  }
}

export function ToastArea() {
  const toast = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return (
    <div className="toast-area" role="status">
      {toast ? (
        <div className={`toast toast-${toast.kind}`} key={toast.id}>
          <span>{toast.text}</span>
          {toast.undoBatchId ? (
            <button type="button" onClick={() => void undo(toast)}>
              Undo
            </button>
          ) : null}
          <button type="button" className="ghost" aria-label="Dismiss" onClick={dismissToast}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
