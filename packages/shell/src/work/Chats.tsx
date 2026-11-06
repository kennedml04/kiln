// Scratch chats: the New chat button, a chat's view and the Chats page. A chat belongs to no
// Project and no Item; it is created on the first message, so opening the view and leaving makes none.
import { useEffect, useState, type FormEvent } from 'react';
import { chatThreadId, type OpenChatResult, type ScratchChat, type ThreadEntry, type ThreadMessageRequest } from '@kiln/widget-sdk';
import { ChatIcon, PlusIcon } from '../Icons.tsx';
import { CHATS_PATH, NEW_CHAT_PATH, chatPath, followLink, navigate, usePath } from '../router.ts';
import { addThreadEntries, api, putChats, useStore } from '../store.ts';
import { MessageForm } from './ItemView.tsx';

const NO_ENTRIES: ThreadEntry[] = [];

/** The header's New chat button: an icon on the phone layout. Viewers never see it. */
export function NewChatButton({ canAct }: { canAct: boolean }) {
  const path = usePath();
  if (!canAct) return null;
  return (
    <a
      href={NEW_CHAT_PATH}
      onClick={followLink}
      className="new-chat button-link"
      aria-current={path === NEW_CHAT_PATH ? 'page' : undefined}
      aria-label="New chat"
    >
      <PlusIcon />
      <span className="new-chat-label">New chat</span>
    </a>
  );
}

/** The sidebar link to the Chats page. */
export function ChatsLink() {
  const path = usePath();
  return (
    <a href={CHATS_PATH} onClick={followLink} aria-current={path === CHATS_PATH ? 'page' : undefined}>
      <ChatIcon />
      Chats
    </a>
  );
}

/** The empty chat: a message box. The first message creates the chat and moves to it. */
export function NewChatView() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const opened = await api<OpenChatResult>('POST', '/api/chats', { text } satisfies ThreadMessageRequest);
      putChats([opened.chat]);
      navigate(chatPath(opened.chat.id));
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
    }
  };
  return (
    <article className="item-view chat-view">
      <h2>New chat</h2>
      <p>Ask a quick, one-off question. A chat reads every registered Project and the web, and changes nothing.</p>
      <form className="thread-message" onSubmit={send}>
        <label>
          Message
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus />
        </label>
        <button type="submit" disabled={sending || !text.trim()}>
          Send
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </article>
  );
}

/** One line of a chat's Thread, or undefined for entries a chat doesn't show. */
function line(entry: ThreadEntry): { who: 'person' | 'agent' | 'system'; text: string } | undefined {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.type) {
    case 'session.message':
      return p.from === 'kiln' ? undefined : { who: 'person', text: String(p.text) };
    case 'session.progress':
      return typeof p.text === 'string' && p.text ? { who: 'agent', text: p.text } : undefined;
    case 'session.started':
      return { who: 'system', text: 'Session started' };
    case 'session.finished':
      return { who: 'system', text: `Session ended (${String(p.reason)})` };
    case 'digest.written':
      return { who: 'system', text: 'Digest written' };
    default:
      return undefined;
  }
}

function ChatLog({ thread }: { thread: ThreadEntry[] }) {
  const lines = thread.flatMap((entry) => {
    const l = line(entry);
    return l ? [{ id: entry.id, ...l }] : [];
  });
  return (
    <ol role="log" aria-label="Thread" aria-live="polite" className="thread-log chat-log">
      {lines.map((l) => (
        <li key={l.id} className={`chat-line chat-${l.who}`}>
          {l.text}
        </li>
      ))}
    </ol>
  );
}

function ChatToolbar({ chat }: { chat: ScratchChat }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [error, setError] = useState<string>();
  const patch = async (body: { title?: string; pinned?: boolean; archived?: boolean }) => {
    setError(undefined);
    try {
      putChats([await api<ScratchChat>('PATCH', `/api/chats/${encodeURIComponent(chat.id)}`, body)]);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && title.trim() !== chat.title) await patch({ title: title.trim() });
    setRenaming(false);
  };
  return (
    <div className="chat-toolbar">
      {renaming ? (
        <form onSubmit={rename} className="chat-rename">
          <label>
            Chat title
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <button type="submit">Save</button>
          <button type="button" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <h2>
          <button
            type="button"
            className="ghost chat-title"
            title="Rename"
            onClick={() => {
              setTitle(chat.title);
              setRenaming(true);
            }}
          >
            {chat.title}
          </button>
        </h2>
      )}
      <button type="button" aria-pressed={chat.pinned} onClick={() => patch({ pinned: !chat.pinned })}>
        {chat.pinned ? 'Unpin' : 'Pin'}
      </button>
      {chat.archivedAt ? (
        <button type="button" onClick={() => patch({ archived: false })}>
          Unarchive
        </button>
      ) : (
        <button type="button" onClick={() => patch({ archived: true })}>
          Archive
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export function ChatView({ chatId }: { chatId: string }) {
  const chat = useStore((s) => s.chats[chatId]);
  const threadId = chatThreadId(chatId);
  const thread = useStore((s) => s.threads[threadId] ?? NO_ENTRIES);
  const [error, setError] = useState<string>();
  const base = `/api/chats/${encodeURIComponent(chatId)}`;

  useEffect(() => {
    let live = true;
    api<ScratchChat>('GET', base)
      .then((c) => live && putChats([c]))
      .catch((err: Error) => live && setError(err.message));
    api<ThreadEntry[]>('GET', `${base}/thread`)
      .then((entries) => live && addThreadEntries(threadId, entries))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [base, threadId]);

  if (!chat) return error ? <p role="alert">{error}</p> : <p>Loading chat…</p>;
  return (
    <article className="item-view chat-view">
      <ChatToolbar chat={chat} />
      {chat.archivedAt ? <p>Archived. Sending a message brings it back.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <section className="thread">
        <h3>Thread</h3>
        <ChatLog thread={thread} />
        <MessageForm messagesPath={`${base}/messages`} />
      </section>
    </article>
  );
}

