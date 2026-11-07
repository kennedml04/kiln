import { useEffect, useRef, useState } from 'react';
import type { ArchiveResetResponse, Item } from '@kiln/widget-sdk';
import { followLink } from '../router.ts';
import { api, useStore } from '../store.ts';
import { showArchived, showToast } from '../toast.tsx';

/** The ⋯ menu at the top of a board: Reset board and a link to Shipped history. */
export function BoardMenu({ projectId }: { projectId?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const role = useStore((s) => s.me?.role);
  const items = useStore((s) => s.items);
  const canReset = role === 'admin' || role === 'member';
  const shipped = Object.values(items).some(
    (i: Item) => i.runState === 'shipped' && !i.archived && (!projectId || i.projectId === projectId),
  );

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const reset = async () => {
    setOpen(false);
    try {
      const r = await api<ArchiveResetResponse>('POST', '/api/archive/reset', projectId ? { projectId } : {});
      showArchived(r.batchId, r.count);
    } catch (err) {
      showToast({ text: (err as Error).message, kind: 'error' });
    }
  };
  const history = projectId ? `/projects/${encodeURIComponent(projectId)}/shipped` : '/shipped';

  return (
    <div className="board-menu" ref={root}>
      <button type="button" className="ghost board-menu-button" aria-label="Board menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open ? (
        <div role="menu" className="board-menu-list">
          {canReset ? (
            <button type="button" role="menuitem" disabled={!shipped} onClick={() => void reset()}>
              Reset board
              {shipped ? null : <small> Nothing in Shipped</small>}
            </button>
          ) : null}
          <a role="menuitem" href={history} onClick={(e) => { setOpen(false); followLink(e); }}>
            Shipped history
          </a>
        </div>
      ) : null}
    </div>
  );
}
