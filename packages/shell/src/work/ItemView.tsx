// One Item: its details, its latest Session's branch and Exit status, and its live Thread.
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { Digest, ExitStatus, Item, Project, ThreadEntry, ThreadMessageRequest } from '@kiln/widget-sdk';
import { followLink, projectPath } from '../router.ts';
import { addThreadEntries, api, useStore } from '../store.ts';
import { StoryLine, useStoryOf } from './StoryLine.tsx';
import { UsagePanel } from './Usage.tsx';

const NO_ENTRIES: ThreadEntry[] = [];

const stageName = (project: Project | undefined, item: Item, stage = item.stage) =>
  project?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === stage)?.name ?? stage;

const kindName = (project: Project | undefined, item: Item) =>
  project?.workflow.kinds.find((k) => k.id === item.kind)?.name ?? item.kind;

const list = (items: string[]) => (items.length ? items.join('; ') : 'nothing');

/** One line of the Thread, in words. `item` is undefined for the Project Thread. */
function describe(entry: ThreadEntry, project: Project | undefined, item: Item | undefined): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.type) {
    case 'digest.written': {
      const d = p.digest as Digest;
      const by = d.kind === 'rollup' ? 'Rollup' : d.writtenBy === 'kiln' ? 'Digest (by Kiln)' : 'Digest';
      return `${by}: decided ${list(d.decided)}. Changed ${list(d.changed)}. Open: ${list(d.open)}.`;
    }
    case 'item.stage_changed':
      return item
        ? `Moved from ${stageName(project, item, String(p.from))} to ${stageName(project, item, String(p.to))}`
        : `Moved from ${String(p.from)} to ${String(p.to)}`;
    case 'item.from_chat':
      return 'Made from a Scratch chat';
    case 'session.started':
      return 'Session started';
    case 'session.progress': {
      const tool = p.tool as { name: string } | undefined;
      return (p.text as string | undefined) ?? (tool ? `Tool: ${tool.name}` : 'Working');
    }
    case 'session.finished':
      return `Agent finished (${String(p.reason)})${p.message ? `: ${String(p.message)}` : ''}`;
    case 'session.message':
      return `${p.from === 'kiln' ? 'Kiln' : 'Person'}: ${String(p.text)}`;
    case 'session.updated':
      return `Session ${String((p.session as { state: string }).state)}`;
    case 'exit.checked':
      return (p.exit as ExitStatus).met ? 'Exit checked: met' : 'Exit checked: not met';
    case 'session.usage':
      return `Turn ${String(p.turn)}: ${String(p.inputTokens)} in, ${String(p.outputTokens)} out`;
    default:
      return entry.type.replace(/^session\./, '').replaceAll('_', ' ');
  }
}

function ExitPanel({ exit }: { exit: ExitStatus | undefined }) {
  return (
    <section aria-label="Exit" className="exit">
      <h3>Exit</h3>
      {exit ? (
        <>
          <p className={exit.met ? 'exit-met' : 'exit-missing'}>{exit.met ? 'Exit met' : 'Exit not met'}</p>
          <ul>
            {exit.checks.map((check) => (
              <li key={check.id} className={check.met ? 'check-met' : 'check-missing'}>
                {check.name}: {check.met ? 'met' : 'missing'}
                {check.detail && !check.met ? <pre>{check.detail}</pre> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Not checked yet</p>
      )}
    </section>
  );
}

/**
 * The Thread's log. New lines are appended without touching the ones shown, so a selection
 * survives; it follows new lines only while the person is at its bottom, and otherwise stays put.
 */
export function ThreadLog({ thread, project, item }: { thread: ThreadEntry[]; project: Project | undefined; item?: Item }) {
  const log = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const onScroll = () => {
    const el = log.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
  };
  useLayoutEffect(() => {
    const el = log.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.length]);
  return (
    <ol ref={log} role="log" aria-label="Thread" aria-live="polite" className="thread-log" onScroll={onScroll}>
      {thread.map((entry) => (
        <li key={entry.id} className={`thread-${entry.type.replace('.', '-')}`}>
          {entry.type === 'item.from_chat' && typeof (entry.payload as { chatId?: unknown }).chatId === 'string' ? (
            <a href={`/chats/${encodeURIComponent((entry.payload.chatId as string))}`} onClick={followLink}>
              {describe(entry, project, item)}
            </a>
          ) : (
            describe(entry, project, item)
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Sends a person's Thread message to `messagesPath`: into the running Session, or one Kiln resumes
 * or starts for it.
 */
export function MessageForm({ messagesPath }: { messagesPath: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setError(undefined);
    setSending(true);
    try {
      const body: ThreadMessageRequest = { text };
      await api('POST', messagesPath, body);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <form className="thread-message" onSubmit={send}>
      <label>
        Message
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
      </label>
      <button type="submit" disabled={sending || !text.trim()}>
        Send
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

export function ItemView({ itemId }: { itemId: string }) {
  const item = useStore((s) => s.items[itemId]);
  const story = useStoryOf(item);
  const project = useStore((s) => (item ? s.projects[item.projectId] : undefined));
  const thread = useStore((s) => s.threads[itemId] ?? NO_ENTRIES);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const role = useStore((s) => s.me?.role);
  const canAct = role === 'admin' || role === 'member';
  const unarchive = async () => {
    setError(undefined);
    try {
      await api('POST', '/api/archive/unarchive', { itemIds: [itemId] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    let live = true;
    api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(itemId)}/thread`)
      .then((entries) => live && addThreadEntries(itemId, entries))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [itemId]);

  if (!item) return <p>Loading the Item…</p>;
  const run = item.run;
  const runningHere = run?.state === 'running' && run.stage === item.stage;

  const start = async () => {
    setError(undefined);
    setStarting(true);
    try {
      await api('POST', `/api/items/${encodeURIComponent(itemId)}/start`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <article className="item-view">
      <h2>{item.title}</h2>
      <StoryLine story={story} />
      {item.archived ? (
        <p className="archived-badge">
          <span className="badge">Archived {new Date(item.archived.at).toLocaleString()}</span>{' '}
          {canAct ? (
            <button type="button" onClick={() => void unarchive()}>
              Unarchive
            </button>
          ) : null}
        </p>
      ) : null}
      {project ? (
        <a href={projectPath(project.id)} onClick={followLink}>
          {project.name}
        </a>
      ) : null}
      <section aria-label="Details">
        <dl>
          <dt>Kind</dt>
          <dd>{kindName(project, item)}</dd>
          <dt>Stage</dt>
          <dd>{stageName(project, item)}</dd>
          {item.status ? (
            <>
              <dt>Status</dt>
              <dd>{item.status}</dd>
            </>
          ) : null}
          {run ? (
            <>
              <dt>Session</dt>
              <dd>
                {run.state} in {stageName(project, item, run.stage)}
              </dd>
              <dt>Branch</dt>
              <dd>{run.branch ?? 'none'}</dd>
              <dt>Worktree</dt>
              <dd>{run.worktree ?? 'none'}</dd>
            </>
          ) : null}
        </dl>
        <button type="button" onClick={start} disabled={starting || runningHere}>
          Start Session
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
      {run?.usage ? <UsagePanel usage={run.usage} /> : null}
      <ExitPanel exit={run?.exit} />
      <section className="thread">
        <h3>Thread</h3>
        <ThreadLog thread={thread} project={project} item={item} />
        <MessageForm messagesPath={`/api/items/${encodeURIComponent(itemId)}/messages`} />
      </section>
    </article>
  );
}
