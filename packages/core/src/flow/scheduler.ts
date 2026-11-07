// The scheduler: Sessions wait in a queue (Up next) for room in their Stage's named capacity pool.
// The queue is ordered by Item priority, then by age. Whenever room may have opened (a Session
// ended, a pool grew, an Agent became ready) the scheduler starts the next Items through the
// Session manager.
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_POOL,
  DEFAULT_POOL_SIZE,
  DEFAULT_STORY_LIMIT,
  MAX_STORY_LIMIT,
  type Item,
  type ItemStageChangedEvent,
  type Pool,
  type ProjectRemovedEvent,
  type QueueEntry,
  type SchedulerState,
  type SessionInfo,
  type SessionUpdatedEvent,
  type StoryLimits,
  type Stage,
  type StartResult,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { SessionManager } from './session-manager.ts';

export interface Scheduler {
  /**
   * Starts a Session for the Item's current Stage when its pool has room; otherwise queues it in Up
   * next. `attended`: a person started it from the Thread, so guards for unattended work (the pace
   * rule) let it through.
   */
  enqueue(itemId: string, options?: { attended?: boolean }): Promise<StartResult>;
  state(): SchedulerState;
  /** Sets how many Sessions a pool runs at once; queued Items start at once if it grew. Returns the new state. */
  setPoolSize(name: string, size: number): Promise<SchedulerState>;
  /** Sets the start order of Up next (dragging on the board). Items left out keep their order after these. */
  reorder(order: string[]): Promise<SchedulerState>;
  /** Sets how many Stories a Project may have in flight (0-10); raising it dispatches at once. */
  setStoryLimit(projectId: string, size: number): Promise<SchedulerState>;
  /** Stop all: halts dispatch and pauses every running Session (nothing is killed) until `resume`. */
  stopAll(): Promise<SchedulerState>;
  /** Continues the Sessions Stop all paused and starts dispatching again. */
  resume(): Promise<SchedulerState>;
  /** Stops dispatching (on shutdown) and waits for the dispatch in progress. */
  close(): Promise<void>;
  /**
   * Adds a start guard, asked before every start: a reason holds the Item in Up next (shown as
   * `held` on its entry) until a later dispatch finds the guard lifted. Budgets use it.
   */
  addGuard(guard: StartGuard): void;
  /**
   * Adds a pool claim: pools an Item takes a slot in besides its Stage's (a local Budget's Sessions
   * also take a `gpu` slot). The Item starts only when every one of its pools has room.
   */
  addPoolClaim(claim: PoolClaim): void;
  /** Tries the queue again, e.g. when a guard may have lifted. */
  poke(): void;
}

/** Why the Item may not start now, or undefined to let it start. `attended`: a person in its Thread started it. */
export type StartGuard = (entry: { itemId: string; projectId: string; attended?: boolean }) => string | undefined;

/** The pools an Item takes a slot in besides its Stage's pool. */
export type PoolClaim = (entry: { itemId: string; projectId: string }) => string[];

interface QueueRow {
  item_id: string;
  project_id: string;
  stage: string;
  pool: string;
  priority: number;
  seq: number;
  enqueued_at: string;
}

/**
 * The Session manager's refusals that mean "not yet", not "this Item cannot start": no Agent can take
 * it yet, or Kiln is waiting to restart when idle (the entry starts on the restarted core).
 */
const NOT_READY = /is not ready|No Agent is ready|waiting to restart/;

const MAX_POOL_SIZE = 64;

const toEntry = (row: QueueRow): QueueEntry => ({
  itemId: row.item_id,
  projectId: row.project_id,
  stage: row.stage,
  pool: row.pool,
  priority: row.priority,
  enqueuedAt: row.enqueued_at,
});

export interface SchedulerDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  sessions: SessionManager;
  /**
   * The pools approved Widgets add through their Manifests (`provides.pools`), with their default
   * sizes. An Admin's stored size wins over the default.
   */
  grantedPools?: () => Record<string, number>;
}

export function createScheduler({ db, bus, work, sessions, grantedPools = () => ({}) }: SchedulerDeps): Scheduler {
  const selectQueue = db.prepare('SELECT * FROM queue ORDER BY priority DESC, seq');
  const insertEntry = db.prepare(
    `INSERT INTO queue (item_id, project_id, stage, pool, priority, seq, enqueued_at)
     VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM queue), ?)`,
  );
  const setPriority = db.prepare('UPDATE queue SET priority = ? WHERE item_id = ?');
  const deleteEntry =db.prepare('DELETE FROM queue WHERE item_id = ?');
  const selectPools = db.prepare('SELECT name, size FROM pools ORDER BY name');
  const selectLimits = db.prepare('SELECT project_id, size FROM story_limits');
  const upsertLimit = db.prepare(
    'INSERT INTO story_limits (project_id, size) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET size = excluded.size',
  );
  const upsertPool = db.prepare('INSERT INTO pools (name, size) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET size = excluded.size');

  /** Which pools each running or paused Session holds a slot in. */
  const slots = new Map<string, string[]>();
  let dispatching: Promise<void> = Promise.resolve();
  let closed = false;
  /** Sessions Stop all paused; resume continues these (and only these). */
  const stoppedByStopAll = new Set<string>();
  const selectPaused = db.prepare('SELECT paused FROM scheduler_state WHERE id = 1');
  const setPaused = db.prepare('UPDATE scheduler_state SET paused = ? WHERE id = 1');
  const isPaused = () => (selectPaused.get() as { paused: number }).paused === 1;

  const guards: StartGuard[] = [];
  /** Items a person queued from the Thread, until they start or leave Up next. */
  const attended = new Set<string>();
  const heldBy = (entry: { itemId: string; projectId: string }) => {
    const asked = attended.has(entry.itemId) ? { ...entry, attended: true } : entry;
    for (const guard of guards) {
      const reason = guard(asked);
      if (reason) return reason;
    }
    return undefined;
  };

  const claims: PoolClaim[] = [];
  /** Every pool an Item takes a slot in: its Stage's pool first, then the claimed ones. */
  const poolsOf = (entry: { itemId: string; projectId: string }, pool: string) => [
    ...new Set([pool, ...claims.flatMap((claim) => claim(entry))]),
  ];

  const queue = () =>
    (selectQueue.all() as unknown as QueueRow[]).map((row) => {
      const entry = toEntry(row);
      const held = heldBy(entry);
      return held ? { ...entry, held } : entry;
    });

  const poolSizes = (): Map<string, number> => {
    const sizes = new Map<string, number>([[DEFAULT_POOL, DEFAULT_POOL_SIZE]]);
    for (const [name, size] of Object.entries(grantedPools())) if (!sizes.has(name)) sizes.set(name, size);
    for (const row of selectPools.all() as unknown as { name: string; size: number }[]) sizes.set(row.name, row.size);
    return sizes;
  };

  const activeIn = (pool: string) => [...slots.values()].filter((held) => held.includes(pool)).length;

  /** Stories in flight per Project (every Project listed) and across the box: the Ticket kind's first-Stage pool, read live. */
  const limits = (): StoryLimits => {
    const stored = new Map(
      (selectLimits.all() as unknown as { project_id: string; size: number }[]).map((r) => [r.project_id, r.size]),
    );
    const perProject: Record<string, number> = {};
    let boxWide = 0;
    for (const project of work.projects()) {
      perProject[project.id] = stored.get(project.id) ?? DEFAULT_STORY_LIMIT;
      const first = project.workflow.kinds.find((k) => k.id === 'ticket')?.stages[0];
      if (first) boxWide = Math.max(boxWide, poolSizes().get(first.pool ?? DEFAULT_POOL) ?? 0);
    }
    return { perProject, boxWide };
  };

  const state = (): SchedulerState => ({
    paused: isPaused(),
    pools: [...poolSizes()].map(([name, size]): Pool => ({ name, size, active: activeIn(name) })),
    queue: queue(),
    limits: limits(),
  });

  const publish = () => bus.publish('scheduler.updated', state());

  const stageOf = (item: Item): Stage | undefined =>
    work.project(item.projectId)?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === item.stage);

  const hasRoom = (pools: string[]) => {
    const sizes = poolSizes();
    return pools.every((pool) => activeIn(pool) < (sizes.get(pool) ?? 0));
  };

  const launch = async (itemId: string, pools: string[]): Promise<SessionInfo> => {
    const session = await sessions.start(itemId);
    slots.set(session.id, pools);
    return session;
  };

  /** Starts queued Items, best first, while their pools have room. */
  const dispatchNow = async (): Promise<void> => {
    if (closed || isPaused()) {
      publish();
      return;
    }
    const blocked = new Set<string>();
    for (const entry of queue()) {
      const pools = poolsOf(entry, entry.pool);
      if (blocked.has(entry.pool) || !hasRoom(pools)) continue;
      const item = work.item(entry.itemId);
      if (!item || item.stage !== entry.stage) {
        deleteEntry.run(entry.itemId);
        attended.delete(entry.itemId);
        work.setUpNext(entry.itemId, false);
        continue;
      }
      // Held by a guard: it keeps its place, and the next Items in the pool may still start.
      if (entry.held) continue;
      try {
        await launch(entry.itemId, pools);
      } catch (err) {
        // No Agent ready yet: the Item keeps its place; dispatch runs again when an Agent is ready.
        if (err instanceof WorkError && NOT_READY.test(err.message)) {
          blocked.add(entry.pool);
          continue;
        }
        bus.publish('scheduler.start_failed', { itemId: entry.itemId, projectId: entry.projectId, error: String(err) });
      }
      deleteEntry.run(entry.itemId);
      attended.delete(entry.itemId);
      work.setUpNext(entry.itemId, false);
    }
    publish();
  };

  const dispatch = () => (dispatching = dispatching.then(dispatchNow, dispatchNow));

  bus.subscribe((event) => {
    if (event.type === 'session.updated') {
      const { session } = (event as SessionUpdatedEvent).payload;
      // A Session waiting on a blocking Ask keeps its slot, like a paused one.
      if (slots.has(session.id) && !['running', 'paused', 'waiting'].includes(session.state)) {
        slots.delete(session.id);
        void dispatch();
      }
    } else if (event.type === 'widget.ready' || event.type === 'widget.approved') {
      void dispatch();
    } else if (event.type === 'project.removed') {
      // An unregistered Project's Items leave Up next, so none starts if the folder is registered again.
      const { projectId } = (event as ProjectRemovedEvent).payload;
      for (const entry of queue().filter((e) => e.projectId === projectId)) {
        deleteEntry.run(entry.itemId);
        attended.delete(entry.itemId);
      }
      publish();
    } else if (event.type === 'item.stage_changed' || event.type === 'item.rework') {
      // An Item entering a Stage that runs a Session (its Exit was met, or a Gate sent it back, maybe
      // to the Gate's own Stage) joins the queue by itself; nobody has to press Start.
      const { itemId, projectId } = (event as ItemStageChangedEvent).payload;
      void admit(itemId).catch((err: unknown) => {
        bus.publish('scheduler.start_failed', { itemId, projectId, error: String(err) });
      });
    }
  });

  /** Starts or queues an Item that just entered a Stage; an Agent not ready yet queues it instead of failing. */
  const admit = async (itemId: string) => {
    const item = work.item(itemId);
    if (!item || item.maintenance || !stageOf(item)?.role) return;
    try {
      await enqueue(itemId);
    } catch (err) {
      if (!(err instanceof WorkError && NOT_READY.test(err.message))) throw err;
      if (queue().some((e) => e.itemId === itemId)) return;
      insertEntry.run(itemId, item.projectId, item.stage, stageOf(item)?.pool ?? DEFAULT_POOL, new Date().toISOString());
      work.setUpNext(itemId, true);
      publish();
    }
  };

  async function enqueue(itemId: string, options: { attended?: boolean } = {}): Promise<StartResult> {
    const item = work.item(itemId);
    if (!item) throw new WorkError(404, `No Item "${itemId}"`);
    if (item.maintenance) throw new WorkError(409, 'The Maintenance Story stays open: it runs no Session of its own');
    const stage = stageOf(item);
    if (!stage?.role) throw new WorkError(409, `${item.title} is in a Stage that runs no Session`);
    const pool = stage.pool ?? DEFAULT_POOL;
    if (!poolSizes().has(pool)) throw new WorkError(409, `${item.title}'s Stage uses the pool "${pool}", which does not exist`);
    if (queue().some((e) => e.itemId === itemId)) throw new WorkError(409, `${item.title} is already in Up next`);
    if (sessions.active().some((s) => s.itemId === itemId)) throw new WorkError(409, `${item.title} already has a running Session`);
    await dispatching;
    if (options.attended) attended.add(itemId);
    const pools = poolsOf({ itemId, projectId: item.projectId }, pool);
    const waitingFirst = queue().some((e) => !e.held && poolsOf(e, e.pool).some((p) => pools.includes(p)));
    if (!isPaused() && hasRoom(pools) && !waitingFirst && !heldBy({ itemId, projectId: item.projectId })) {
      attended.delete(itemId);
      const session = await launch(itemId, pools);
      publish();
      return { queued: false, session };
    }
    insertEntry.run(itemId, item.projectId, item.stage, pool, new Date().toISOString());
    work.setUpNext(itemId, true);
    publish();
    return { queued: true, entry: queue().find((e) => e.itemId === itemId)! };
  }

  // Entries queued before a restart are still waiting: start them once Agents are ready.
  for (const entry of queue()) work.setUpNext(entry.itemId, true, { quiet: true });

  return {
    enqueue,
    state,
    async setPoolSize(name, size) {
      if (!poolSizes().has(name)) throw new WorkError(404, `No pool "${name}"`);
      if (!Number.isInteger(size) || size < 0 || size > MAX_POOL_SIZE) {
        throw new WorkError(400, `A pool's size is a whole number from 0 to ${MAX_POOL_SIZE}`);
      }
      upsertPool.run(name, size);
      await dispatch();
      return state();
    },
    async setStoryLimit(projectId, size) {
      if (!work.project(projectId)) throw new WorkError(404, `No Project "${projectId}"`);
      if (!Number.isInteger(size) || size < 0 || size > MAX_STORY_LIMIT) {
        throw new WorkError(400, `A Project's Story limit is a whole number from 0 to ${MAX_STORY_LIMIT}`);
      }
      upsertLimit.run(projectId, size);
      await dispatch();
      return state();
    },
    async reorder(order) {
      if (!Array.isArray(order)) throw new WorkError(400, 'Give the Up next order as a list of Item ids');
      const entries = queue();
      const queued = new Set(entries.map((e) => e.itemId));
      const missing = order.find((id) => !queued.has(id));
      if (missing) throw new WorkError(409, `"${missing}" is not waiting in Up next`);
      const listed = new Set(order);
      const rest = entries.filter((e) => !listed.has(e.itemId)).map((e) => e.priority);
      const base = rest.length ? Math.max(...rest) : 0;
      db.exec('BEGIN');
      try {
        order.forEach((id, i) => setPriority.run(base + order.length - i, id));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      await dispatch();
      return state();
    },
    async stopAll() {
      setPaused.run(1);
      await dispatching;
      for (const session of sessions.active()) {
        if (session.state !== 'running') continue;
        stoppedByStopAll.add(session.id);
        sessions.pause(session.id);
      }
      publish();
      return state();
    },
    async resume() {
      setPaused.run(0);
      const ids = [...stoppedByStopAll];
      stoppedByStopAll.clear();
      for (const id of ids) {
        // A Session paused past its Agent's cache lifetime has ended: its Item starts fresh from Digests.
        if ((await sessions.resume(id)) !== 'expired') continue;
        const itemId = sessions.session(id)?.itemId;
        if (!itemId) continue;
        await this.enqueue(itemId).catch((err: unknown) => {
          bus.publish('scheduler.start_failed', { itemId, projectId: sessions.session(id)!.projectId, error: String(err) });
        });
      }
      await dispatch();
      return state();
    },
    async close() {
      closed = true;
      await dispatching;
    },
    addGuard(guard) {
      guards.push(guard);
    },
    addPoolClaim(claim) {
      claims.push(claim);
    },
    poke() {
      void dispatch();
    },
  };
}
