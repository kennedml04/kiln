// The archive: Reset board marks shipped Items as archived (a Kiln-only view mark, keyed by Item id),
// one batch per Reset. Nothing here touches a Tracker or a repo.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, ArchiveBatch, ArchiveResetResponse, Item, KilnEvent } from '@kiln/widget-sdk';
import type { AuditLog } from '../audit.ts';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from './work.ts';

export interface ArchiveService {
  reset(request: { actor: Actor; projectId?: string }): ArchiveResetResponse;
  /** Puts back the named Items, or the batch's remaining ones. Returns the Item ids put back. */
  unarchive(request: { actor: Actor; itemIds?: string[]; batchId?: string }): string[];
  /** Batches newest first, each with its still-archived Items that the Trackers still list. */
  history(filter?: { projectId?: string; q?: string }): ArchiveBatch[];
  archivedOf(itemId: string): { at: string; batchId: string } | undefined;
}

interface BatchRow {
  id: string;
  actor_id: string;
  actor_name: string | null;
  at: string;
  project_id: string | null;
  count: number;
}

export function createArchive(deps: { db: DatabaseSync; bus: EventBus; work: Work; audit: AuditLog }): ArchiveService {
  const { db, bus, work, audit } = deps;
  const insertBatch = db.prepare('INSERT INTO archive_batches (id, actor_id, actor_name, at, project_id, count) VALUES (?, ?, ?, ?, ?, ?)');
  const insertItem = db.prepare('INSERT INTO archived_items (item_id, batch_id, archived_at) VALUES (?, ?, ?)');
  const deleteItem = db.prepare('DELETE FROM archived_items WHERE item_id = ?');
  const rowOf = db.prepare('SELECT batch_id, archived_at FROM archived_items WHERE item_id = ?');
  const allRows = db.prepare('SELECT item_id, batch_id, archived_at FROM archived_items');
  const batchRows = db.prepare('SELECT item_id FROM archived_items WHERE batch_id = ?');
  const batchById = db.prepare('SELECT id FROM archive_batches WHERE id = ?');
  const batches = db.prepare('SELECT * FROM archive_batches ORDER BY at DESC, rowid DESC');

  type Row = { item_id: string; batch_id: string; archived_at: string };
  const archivedOf = (itemId: string) => {
    const row = rowOf.get(itemId) as { batch_id: string; archived_at: string } | undefined;
    return row ? { at: row.archived_at, batchId: row.batch_id } : undefined;
  };
  for (const row of allRows.all() as Row[]) work.setArchived(row.item_id, { at: row.archived_at, batchId: row.batch_id }, { quiet: true });

  const clearing = new Set<string>();
  /** The clearing rule: an archived Item that is no longer shipped loses its mark. */
  const check = (itemId: string) => {
    if (clearing.has(itemId)) return;
    const mark = archivedOf(itemId);
    const item = work.item(itemId);
    if (!mark || !item || item.runState === 'shipped') return;
    clearing.add(itemId);
    try {
      deleteItem.run(itemId);
      work.setArchived(itemId, undefined);
      audit.record({
        actor: { kind: 'kiln' },
        action: 'archive.cleared',
        target: `item:${itemId}`,
        outcome: 'allowed',
        detail: { batchId: mark.batchId, reason: `no longer shipped (${item.runState})` },
      });
    } finally {
      clearing.delete(itemId);
    }
  };
  bus.subscribe((event: KilnEvent) => {
    if (event.type === 'item.updated') check((event.payload as { item: Item }).item.id);
    else if (event.type === 'item.stage_changed') check((event.payload as { itemId: string }).itemId);
  });
  // At core start the Projects have loaded (Work opens them first): check every archived row.
  void work.ready().then(() => {
    for (const row of allRows.all() as Row[]) check(row.item_id);
  });

  const who = (actor: Actor) => ({ id: actor.kind === 'kiln' ? 'kiln' : actor.id, ...(actor.kind === 'user' && actor.name ? { name: actor.name } : {}) });

  const put = (itemIds: string[]): string[] => {
    const back: string[] = [];
    for (const id of new Set(itemIds)) {
      if (!archivedOf(id)) continue;
      deleteItem.run(id);
      work.setArchived(id, undefined);
      back.push(id);
    }
    return back;
  };

  return {
    archivedOf,

    reset({ actor, projectId }) {
      if (projectId !== undefined && !work.project(projectId)) throw new WorkError(404, `No Project "${projectId}"`);
      const items = work.items(projectId).filter((i) => i.runState === 'shipped' && !archivedOf(i.id));
      if (!items.length) throw new WorkError(409, 'Nothing in Shipped');
      const batchId = randomUUID();
      const at = new Date().toISOString();
      const person = who(actor);
      db.exec('BEGIN');
      try {
        insertBatch.run(batchId, person.id, person.name ?? null, at, projectId ?? null, items.length);
        for (const item of items) insertItem.run(item.id, batchId, at);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      for (const item of items) work.setArchived(item.id, { at, batchId });
      bus.publish('archive.reset', { batchId, ...(projectId ? { projectId } : {}), count: items.length });
      return { batchId, count: items.length, itemIds: items.map((i) => i.id) };
    },

    unarchive({ itemIds, batchId }) {
      if ((itemIds === undefined) === (batchId === undefined)) throw new WorkError(400, 'Give either batchId or itemIds');
      let ids: string[];
      if (batchId !== undefined) {
        if (!batchById.get(batchId)) throw new WorkError(404, `No Reset "${batchId}"`);
        ids = (batchRows.all(batchId) as { item_id: string }[]).map((r) => r.item_id);
      } else {
        if (!Array.isArray(itemIds) || itemIds.some((i) => typeof i !== 'string')) throw new WorkError(400, 'itemIds must be a list of Item ids');
        ids = itemIds;
      }
      const back = put(ids);
      bus.publish('archive.unarchived', { ...(batchId ? { batchId } : {}), itemIds: back });
      return back;
    },

    history({ projectId, q } = {}) {
      const needle = q?.trim().toLowerCase();
      const byBatch = new Map<string, Item[]>();
      for (const row of allRows.all() as Row[]) {
        const item = work.item(row.item_id);
        if (!item) continue; // Gone from the Tracker: kept, but skipped.
        if (projectId && item.projectId !== projectId) continue;
        if (needle && !item.title.toLowerCase().includes(needle) && !item.key.toLowerCase().includes(needle)) continue;
        (byBatch.get(row.batch_id) ?? byBatch.set(row.batch_id, []).get(row.batch_id)!).push(item);
      }
      const out: ArchiveBatch[] = [];
      for (const b of batches.all() as unknown as BatchRow[]) {
        if (projectId && b.project_id !== null && b.project_id !== projectId) continue;
        const items = byBatch.get(b.id) ?? [];
        if (needle && !items.length) continue;
        // An all-Projects Reset belongs to a Project's history only through Items of that Project.
        if (projectId && b.project_id === null && !items.length) continue;
        out.push({
          id: b.id,
          actor: { id: b.actor_id, ...(b.actor_name ? { name: b.actor_name } : {}) },
          at: b.at,
          ...(b.project_id ? { projectId: b.project_id } : {}),
          count: b.count,
          items,
        });
      }
      return out;
    },
  };
}
