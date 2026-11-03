// Needs you: every open Ask, the ones blocking the most work first, then the oldest.
// The header link carries the live count on every page.
import { useId, useMemo, useState, type FormEvent } from 'react';
import { GATE_REJECT, projectOfThread, type Ask, type Item, type Project, type Proposal } from '@kiln/widget-sdk';
import { InboxIcon } from './Icons.tsx';
import { followLink, itemPath, projectThreadPath, usePath } from './router.ts';
import { api, openAsks, useStore } from './store.ts';

const TYPE_NAMES: Record<Ask['type'], string> = {
  decision: 'Decision',
  permission: 'Permission',
  review: 'Review',
  question: 'Question',
};

export const NEEDS_YOU_PATH = '/needs-you';

/** The header link to Needs you with its open count. */
export function NeedsYouLink() {
  const count = useStore((s) => Object.keys(s.asks).length);
  const path = usePath();
  return (
    <a
      href={NEEDS_YOU_PATH}
      onClick={followLink}
      aria-current={path === NEEDS_YOU_PATH ? 'page' : undefined}
      aria-label={`Needs you, ${count === 0 ? 'nothing open' : `${count} open`}`}
    >
      <InboxIcon />
      Needs you{' '}
      <span className={count > 0 ? 'badge badge-open' : 'badge'} aria-hidden="true">
        {count}
      </span>
    </a>
  );
}

/** A proposal in words, e.g. `create Ticket "Draw the cards"`. */
function describeProposal(proposal: Proposal, project: Project | undefined, items: Record<string, Item>): string {
  if (proposal.kind === 'reorder_queue') {
    return `start Up next in this order: ${proposal.order.map((id) => items[id]?.title ?? id).join(', ')}`;
  }
  const kindName = (kind: string) => project?.workflow.kinds.find((k) => k.id === kind)?.name ?? kind;
  return proposal.items
    .map((i) => `create ${kindName(i.kind)} "${i.title}"${i.parentId ? ` under ${items[i.parentId]?.title ?? i.parentId}` : ''}`)
    .join('; ');
}

/** What an Ask is about: its Item, or the Project Thread it came from. */
function AskSubject({ ask }: { ask: Ask }) {
  const item = useStore((s) => s.items[ask.itemId]);
  const project = useStore((s) => s.projects[ask.projectId]);
  if (projectOfThread(ask.itemId) !== undefined) {
    return (
      <a href={projectThreadPath(ask.projectId)} onClick={followLink}>
        {project?.name ?? ask.projectId} Project Thread
      </a>
    );
  }
  return (
    <a href={itemPath(ask.itemId)} onClick={followLink}>
      {item?.title ?? ask.itemId}
    </a>
  );
}

function AskCard({ ask }: { ask: Ask }) {
  const headingId = useId();
  const project = useStore((s) => s.projects[ask.projectId]);
  const items = useStore((s) => s.items);
  const [answer, setAnswer] = useState(ask.recommendation);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  // A Gate's Review Ask: rejecting it needs a comment saying what to change.
  const gate = ask.raisedBy.kind === 'gate' && ask.type === 'review';
  const needsComment = gate && answer === GATE_REJECT && comment.trim() === '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(undefined);
    try {
      await api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer, ...(gate && comment.trim() ? { comment } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <article aria-labelledby={headingId} className="ask">
      <p className="ask-meta">
        <span>{TYPE_NAMES[ask.type]}</span>
        {ask.blocking ? <span className="ask-blocking">Blocking</span> : <span>Not blocking</span>}
        {ask.blocks > 0 && <span>Holds up {ask.blocks === 1 ? '1 piece of work' : `${ask.blocks} pieces of work`}</span>}
        <AskSubject ask={ask} />
      </p>
      <h3 id={headingId}>{ask.question}</h3>
      <p className="ask-why">{ask.why}</p>
      {ask.proposal ? (
        <p className="ask-proposal">Proposed: {describeProposal(ask.proposal, project, items)}</p>
      ) : null}
      {ask.review && (
        <div className="ask-review">
          <section aria-label={ask.review.artifact ?? 'Review findings'}>
            <h4>{ask.review.artifact ?? 'Review findings'}</h4>
            <pre>{ask.review.findings}</pre>
          </section>
          <section aria-label="What the branch changes">
            <h4>
              Changes on {ask.review.branch} against {ask.review.base}
            </h4>
            <pre>{ask.review.diffSummary || 'No changes.'}</pre>
          </section>
        </div>
      )}
      <p>
        Recommended: <strong>{ask.recommendation}</strong>
      </p>
      <form onSubmit={submit}>
        {ask.options ? (
          <fieldset>
            <legend>Your answer</legend>
            {ask.options.map((option) => (
              <label key={option} className={answer === option ? 'is-checked' : undefined}>
                <input
                  type="radio"
                  name={`answer-${ask.id}`}
                  value={option}
                  checked={answer === option}
                  onChange={() => setAnswer(option)}
                />
                {option}
              </label>
            ))}
          </fieldset>
        ) : (
          <label>
            Your answer <input value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
        )}
        {gate && (
          <label className="ask-comment">
            Comment{answer === GATE_REJECT ? ' (needed to reject)' : ''}
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} />
          </label>
        )}
        <button type="submit" disabled={sending || answer.trim() === '' || needsComment}>
          Answer
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </article>
  );
}

export function NeedsYouPage() {
  const asks = useStore((s) => s.asks);
  const ordered = useMemo(() => openAsks(asks), [asks]);
  return (
    <section aria-label="Needs you" className="needs-you">
      <h2>Needs you</h2>
      {ordered.length === 0 ? <p>Nothing needs you.</p> : ordered.map((ask) => <AskCard key={ask.id} ask={ask} />)}
    </section>
  );
}
