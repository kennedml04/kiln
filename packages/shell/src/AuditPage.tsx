// The Admin's audit log page: every change and refusal, newest first, with filters.
import { useEffect, useState, type FormEvent } from 'react';
import type { Actor, AuditEntry, AuditOutcome } from '@kiln/widget-sdk';
import { api } from './api.ts';

interface Filters {
  actor: string;
  action: string;
  outcome: AuditOutcome | '';
}

const EMPTY: Filters = { actor: '', action: '', outcome: '' };

const describeActor = (actor: Actor) => {
  switch (actor.kind) {
    case 'user':
      return actor.id === 'local' ? 'Local Admin' : (actor.name ?? actor.id);
    case 'session':
      return `Session ${actor.id} (${actor.agent})`;
    case 'widget':
      return `Widget ${actor.id}`;
    case 'kiln':
      return 'Kiln';
  }
};

const queryString = (filters: Filters) => {
  const params = new URLSearchParams();
  if (filters.actor) params.set('actorId', filters.actor);
  if (filters.action) params.set('action', filters.action);
  if (filters.outcome) params.set('outcome', filters.outcome);
  const text = params.toString();
  return text ? `?${text}` : '';
};

export function AuditPage() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let current = true;
    api<AuditEntry[]>('GET', `/api/audit${queryString(applied)}`)
      .then((list) => current && (setEntries(list), setError(undefined)))
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [applied]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ ...draft });
  };

  return (
    <section className="audit">
      <h2>Audit log</h2>
      <form className="filters" onSubmit={apply}>
        <label>
          Actor
          <input value={draft.actor} placeholder="user id" onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
        </label>
        <label>
          Action
          <input value={draft.action} placeholder="contains" onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        </label>
        <label>
          Outcome
          <select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value as Filters['outcome'] })}>
            <option value="">Any</option>
            <option value="allowed">Allowed</option>
            <option value="refused">Refused</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button type="submit">Apply</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {entries && entries.length === 0 && <p>No entries match.</p>}
      {entries && entries.length > 0 && (
        <table aria-label="Audit log">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className={`outcome-${entry.outcome}`}>
                <td data-label="When">
                  <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                </td>
                <td data-label="Actor">{describeActor(entry.actor)}</td>
                <td data-label="Action">{entry.action}</td>
                <td data-label="Target">{entry.target ?? ''}</td>
                <td data-label="Outcome">
                  {entry.outcome}
                  {entry.reason ? ` (${entry.reason})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
