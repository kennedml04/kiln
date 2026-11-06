// The Chats page: the caller's chats, pinned first, then by last message, with an Archived tab.
// Admins get an "Everyone's chats" toggle that adds an owner column.
import { useEffect, useMemo, useState } from 'react';
import type { ScratchChat } from '@kiln/widget-sdk';
import { PinIcon } from '../Icons.tsx';
import { chatPath, followLink } from '../router.ts';
import { api, putChats, useStore } from '../store.ts';

const when = (iso: string) => new Date(iso).toLocaleString();

export function ChatsPage({ isAdmin }: { isAdmin: boolean }) {
  const chats = useStore((s) => s.chats);
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<'chats' | 'archived'>('chats');
  const [everyone, setEveryone] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!everyone) return;
    let live = true;
    Promise.all([api<ScratchChat[]>('GET', '/api/chats?all=1'), api<ScratchChat[]>('GET', '/api/chats?all=1&archived=1')])
      .then(([a, b]) => live && putChats([...a, ...b]))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [everyone]);

  const mine = me?.actor.kind === 'user' ? me.actor.id : undefined;
  const rows = useMemo(() => {
    const archived = tab === 'archived';
    return Object.values(chats)
      .filter((c) => (c.archivedAt !== undefined) === archived)
      .filter((c) => everyone || c.ownerId === mine)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt));
  }, [chats, tab, everyone, mine]);

  return (
    <section aria-label="Chats" className="chats-page">
      <h2>Chats</h2>
      <div className="chat-tabs">
        <div role="tablist" aria-label="Chat lists">
          <button type="button" role="tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>
            Chats
          </button>
          <button type="button" role="tab" aria-selected={tab === 'archived'} onClick={() => setTab('archived')}>
            Archived
          </button>
        </div>
        {isAdmin ? (
          <label className="chat-everyone">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            Everyone's chats
          </label>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {rows.length === 0 ? (
        <p>{tab === 'archived' ? 'No archived chats.' : 'No chats yet. Use New chat to ask a quick question.'}</p>
      ) : (
        <ul className="chat-list">
          {rows.map((c) => (
            <li key={c.id}>
              {c.pinned ? (
                <span className="chat-pin" role="img" aria-label="Pinned">
                  <PinIcon />
                </span>
              ) : null}
              <a href={chatPath(c.id)} onClick={followLink}>
                {c.title}
              </a>
              <time dateTime={c.lastMessageAt}>{when(c.lastMessageAt)}</time>
              {everyone ? <span className="chat-owner">{c.ownerId}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
