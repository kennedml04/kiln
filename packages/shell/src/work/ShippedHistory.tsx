// Shipped history: Resets newest first, each with the Items of it that are still archived.
import { useCallback, useEffect, useState } from 'react';
import type { ArchiveBatch, ArchiveHistoryResponse, Item } from '@kiln/widget-sdk';
import { followLink, itemPath } from '../router.ts';
import { api, useStore } from '../store.ts';

export const SHIPPED_PATH = '/shipped';
export const shippedPath = (projectId?: string) =>
  projectId ? `/projects/${encodeURIComponent(projectId)}/shipped` : SHIPPED_PATH;

const when = (iso: string) => new Date(iso).toLocaleString();

export function ShippedHistory({ projectId }: { projectId?: string }) {
  const projects = useStore((s) => s.projects);
  const role = useStore((s) => s.me?.role);
  const lastEvent = useStore((s) => s.lastEvent);
  const canAct = role === 'admin' || role === 'member';
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [batches, setBatches] = useState<ArchiveBatch[]>();
  const [error, setError] = useState<string>();
  const scope = projectId ?? filter;

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // item.updated only matters for Items that are archived or listed on this page (a mark just cleared).
  const listed = new Set((batches ?? []).flatMap((b) => b.items.map((i) => i.id)));
  const updated = lastEvent?.type === 'item.updated' ? (lastEvent.payload as { item?: Item }).item : undefined;
  const relevant = lastEvent?.type.startsWith('archive.') || (updated && (updated.archived || listed.has(updated.id)));
  const refreshOn = lastEvent && relevant ? lastEvent.id : undefined;
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (scope) params.set('projectId', scope);
    if (q) params.set('q', q);
    const query = params.toString();
    api<ArchiveHistoryResponse>('GET', `/api/archive${query ? `?${query}` : ''}`)
      .then((r) => live && (setBatches(r.batches), setError(undefined)))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [scope, q, refreshOn]);

  const unarchive = async (body: { batchId: string } | { itemIds: string[] }) => {
    setError(undefined);
    try {
      await api('POST', '/api/archive/unarchive', body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const projectName = (id: string | undefined) => (id ? (projects[id]?.name ?? id) : 'All Projects');
  const shown = (batches ?? []).filter((b) => !q || b.items.length > 0);

  return (
    <section className="shipped-history" aria-label="Shipped history">
      <h2>{projectId ? `Shipped history: ${projectName(projectId)}` : 'Shipped history'}</h2>
      <div className="toolbar">
        <input type="search" aria-label="Search Shipped history" placeholder="Title or key" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!projectId && (
          <select aria-label="Project" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            {Object.values(projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {batches && shown.length === 0 ? <p>{q ? 'No archived Items match.' : 'Nothing has been archived yet.'}</p> : null}
      {shown.map((batch) => (
        <article key={batch.id} className="reset-batch" aria-label={`Reset ${batch.id}`}>
          <header>
            <h3>
              {when(batch.at)}, {batch.actor.name ?? batch.actor.id}, {projectName(batch.projectId)}: {batch.count} {batch.count === 1 ? 'Item' : 'Items'} ({batch.items.length} still archived)
            </h3>
            {canAct && batch.items.length > 0 && !q ? (
              <button type="button" onClick={() => void unarchive({ batchId: batch.id })}>
                Unarchive batch
              </button>
            ) : null}
          </header>
          <ul>
            {batch.items.map((item) => (
              <HistoryItem key={item.id} item={item} showProject={!projectId} projectName={projectName(item.projectId)} canAct={canAct} onUnarchive={() => void unarchive({ itemIds: [item.id] })} />
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

function HistoryItem({ item, showProject, projectName, canAct, onUnarchive }: { item: Item; showProject: boolean; projectName: string; canAct: boolean; onUnarchive: () => void }) {
  const kind = useStore((s) => s.projects[item.projectId]?.workflow.kinds.find((k) => k.id === item.kind)?.name ?? item.kind);
  return (
    <li>
      {showProject ? <span className="history-project">{projectName}</span> : null} <span className="history-kind">{kind}</span>{' '}
      <a href={itemPath(item.id)} onClick={followLink}>
        {item.title}
      </a>{' '}
      <code>{item.key}</code>
      {canAct ? (
        <button type="button" onClick={onUnarchive}>
          Unarchive
        </button>
      ) : null}
    </li>
  );
}
