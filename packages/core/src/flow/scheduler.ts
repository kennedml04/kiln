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
  type ItemRemovedEvent,
  type ItemStageChangedEvent,
  type Pool,
  type ProjectRemovedEvent,
  type QueueEntry,
  type SchedulerState,
  type SessionInfo,
  type SessionUpdatedEvent,
  type StoryLimits,
  type Stage,
  type StoryEntry,
  type StartResult,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { SessionManager } from './session-manager.ts';
import { startOrder } from './start-order.ts';

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
  /** Sets how many Stories a Project may have in flight (0-10). Raising it starts held Tickets at once. */
  setStoryLimit(projectId: string, limit: number): Promise<SchedulerState>;
  /**
   * Sets the Story order (dragging on the board). Ids are Story ids; Ticket ids are accepted for one
   * release and move their Story. With `projectId` only that Project's Stories change places, within
   * the positions they already held.
   */
  reorder(order: string[], projectId?: string): Promise<SchedulerState>;
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
  const selectQueue = db.prepare('SELECT * FROM queue ORDER BY seq');
  const selectStoryOrder = db.prepare('SELECT story_id, project_id, position FROM story_order');
  const insertStory = db.prepare(
    `INSERT OR IGNORE INTO story_order (story_id, project_id, position)
     VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM story_order))`,
  );
  const setPosition = db.prepare('UPDATE story_order SET position = ? WHERE story_id = ?');
  const deleteStory = db.prepare('DELETE FROM story_order WHERE story_id = ?');
  const deleteProjectStories = db.prepare('DELETE FROM story_order WHERE project_id = ?');
  const selectLimit = db.prepare('SELECT size FROM story_limits WHERE project_id = ?');
  const upsertLimit = db.prepare(
    'INSERT INTO story_limits (project_id, size) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET size = excluded.size',
  );
  const insertEntry = db.prepare(
    `INSERT INTO queue (item_id, project_id, stage, pool, priority, seq, enqueued_at)
     VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(seq), 0) + 1 FROM queue), ?)`,
  );
  const deleteEntry =db.prepare('DELETE FROM queue WHERE item_id = ?');
  const selectPools = db.prepare('SELECT name, size FROM pools ORDER BY name');
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

  /**
   * The Story an Item is ordered under: a Story itself, a Ticket's parent Story. An Item with no
   * Story (until Maintenance Stories exist) is ordered as its own entry.
   */
  const storyKeyOf = (itemId: string): string => {
    const item = work.item(itemId);
    if (!item || item.kind === 'story') return itemId;
    return item.parentId && work.item(item.parentId)?.kind === 'story' ? item.parentId : itemId;
  };
  const positions = () =>
    new Map(
      (selectStoryOrder.all() as unknown as { story_id: string; project_id: string; position: number }[]).map((r) => [
        r.story_id,
        { projectId: r.project_id, position: r.position },
      ]),
    );
  /** A Story with work waiting joins the bottom of the order the first time. */
  const joinOrder = (itemId: string, projectId: string) => void insertStory.run(storyKeyOf(itemId), projectId);

  // First start after the upgrade: seed the order from the queue as it stood (oldest first, first Story wins).
  if (!selectStoryOrder.get()) {
    for (const row of db.prepare('SELECT * FROM queue ORDER BY priority DESC, seq').all() as unknown as QueueRow[]) {
      joinOrder(row.item_id, row.project_id);
    }
  }

  /** What the scheduler works out about one Story every time it looks; nothing of it is stored. */
  interface Facts {
    story: Item;
    tickets: Item[];
    unshipped: Item[];
    started: boolean;
    parked: boolean;
    inFlight: boolean;
  }

  const shipped = (item: Item) => item.runState === 'shipped';
  /** A Ticket waits on a person: a blocking Ask, a Gate decision, a "Your move" Stage, or another Story's Ticket. */
  const waitsOnPerson = (ticket: Item, seen: Set<string> = new Set()): boolean => {
    if (ticket.runState === 'running') return false;
    if (ticket.runState === 'waiting') return true;
    const stage = stageOf(ticket);
    if (stage && !stage.role) return true;
    // Blocked only by Tickets that are themselves waiting on a person (or belong to another Story).
    // Tickets that only block each other wait on nobody, so their Story keeps its slot.
    seen.add(ticket.id);
    const open = (ticket.blockedBy ?? []).map((id) => work.item(id)).filter((b): b is Item => !!b && !shipped(b));
    return (
      open.length > 0 &&
      open.every((b) => b.parentId !== ticket.parentId || (!seen.has(b.id) && waitsOnPerson(b, seen)))
    );
  };

  const storyFacts = (): Map<string, Facts> => {
    const facts = new Map<string, Facts>();
    for (const story of work.items()) {
      if (story.kind !== 'story' || shipped(story)) continue;
      const tickets = story.childIds.map((id) => work.item(id)).filter((i): i is Item => !!i && i.kind === 'ticket');
      const unshipped = tickets.filter((t) => !shipped(t));
      const started = tickets.some((t) => t.run);
      const parked = started && unshipped.length > 0 && unshipped.every((t) => waitsOnPerson(t));
      facts.set(story.id, { story, tickets, unshipped, started, parked, inFlight: started && !parked && unshipped.length > 0 });
    }
    return facts;
  };

  const storyIdFor = (itemId: string, facts: Map<string, Facts>): string | undefined => {
    if (facts.has(itemId)) return itemId;
    const parent = work.item(itemId)?.parentId;
    return parent && facts.has(parent) ? parent : undefined;
  };

  /** A Ticket's number within its Story: the last part of its key. */
  const ticketNumber = (itemId: string) => {
    const n = Number(work.item(itemId)?.key.split('/').pop());
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  };

  const blockedHold = (ticket: Item): string | undefined => {
    for (const id of ticket.blockedBy ?? []) {
      const blocker = work.item(id);
      if (!blocker || shipped(blocker)) continue;
      const [, story, number] = blocker.key.split('/');
      if (number === undefined) return `Blocked by ${blocker.title}`;
      return `Blocked by ${blocker.parentId === ticket.parentId ? number : `${story}/${number}`}`;
    }
    return undefined;
  };

  const storyLimitOf = (projectId: string) =>
    (selectLimit.get(projectId) as { size: number } | undefined)?.size ?? DEFAULT_STORY_LIMIT;
  const ticketPool = (projectId: string): string | undefined => {
    const kind = work.project(projectId)?.workflow.kinds.find((k) => k.id === 'ticket');
    return kind ? (kind.stages[0]?.pool ?? DEFAULT_POOL) : undefined;
  };
  /** The box-wide cap on Stories in flight: the size of the pool the Ticket kind's first Stage uses. */
  const boxCap = (projectId: string) => {
    const pool = ticketPool(projectId);
    return pool === undefined ? Infinity : (poolSizes().get(pool) ?? 0);
  };

  /**
   * Why a Ticket may not start under the Story rules, or undefined. `claimed`: Stories that earlier
   * entries of this pass would put in flight (they count against the limits though not started yet).
   */
  const storyHold = (ticket: Item, pool: string, facts: Map<string, Facts>, claimed: Set<string>): string | undefined => {
    const storyId = storyIdFor(ticket.id, facts);
    const f = storyId ? facts.get(storyId) : undefined;
    if (!storyId || !f) return undefined;
    if (f.inFlight || claimed.has(storyId)) {
      const share = Math.max(1, (poolSizes().get(pool) ?? 0) - 1);
      const held = [...slots].filter(
        ([sessionId, pools]) => pools.includes(pool) && f.tickets.some((t) => t.id === sessions.session(sessionId)?.itemId),
      ).length;
      return held >= share ? "Story already holds its share of the pool" : undefined;
    }
    const flying = [...facts.values()].filter((x) => x.inFlight || claimed.has(x.story.id));
    const inProject = flying.filter((x) => x.story.projectId === ticket.projectId).length;
    return inProject < storyLimitOf(ticket.projectId) && flying.length < boxCap(ticket.projectId) ? undefined : 'Waiting for a Story slot';
  };

  /** The queue in start order, each entry with the reason it is held now, if any. */
  const queue = (): QueueEntry[] => {
    const order = positions();
    const facts = storyFacts();
    const entries = (selectQueue.all() as unknown as QueueRow[]).map((row) => {
      const storyId = storyIdFor(row.item_id, facts);
      return { ...toEntry(row), ...(storyId ? { storyId } : {}) };
    });
    const places = [...facts.values()].map((f) => ({
      storyId: f.story.id,
      started: f.started,
      position: order.get(f.story.id)?.position ?? Number.MAX_VALUE,
    }));
    const claimed = new Set<string>();
    return startOrder(entries, places, ticketNumber).map((entry) => {
      const item = work.item(entry.itemId);
      let held: string | undefined;
      if (item?.kind === 'ticket') held = blockedHold(item);
      held ??= heldBy(entry);
      if (!held && item?.kind === 'ticket') {
        held = storyHold(item, entry.pool, facts, claimed);
        if (!held && entry.storyId) claimed.add(entry.storyId);
      }
      return held ? { ...entry, held } : entry;
    });
  };

  const poolSizes = (): Map<string, number> => {
    const sizes = new Map<string, number>([[DEFAULT_POOL, DEFAULT_POOL_SIZE]]);
    for (const [name, size] of Object.entries(grantedPools())) if (!sizes.has(name)) sizes.set(name, size);
    for (const row of selectPools.all() as unknown as { name: string; size: number }[]) sizes.set(row.name, row.size);
    return sizes;
  };

  const activeIn = (pool: string) => [...slots.values()].filter((held) => held.includes(pool)).length;

  const storyEntries = (entries: QueueEntry[]): StoryEntry[] => {
    const facts = storyFacts();
    const order = positions();
    const queued = new Set(entries.map((e) => e.storyId).filter((id): id is string => !!id));
    const ticketsRunning = (f: Facts) => f.tickets.filter((t) => t.runState === 'running').map((t) => t.id);
    // A Story's own Session (Grill, Spec, Tickets) shows as the Story itself running.
    const running = (f: Facts) => (f.story.runState === 'running' && !ticketsRunning(f).length ? [f.story.id] : ticketsRunning(f));
    return [...facts.values()]
      .filter((f) => queued.has(f.story.id) || f.inFlight || f.parked || running(f).length > 0)
      .sort(
        (a, b) =>
          Number(b.started) - Number(a.started) ||
          (order.get(a.story.id)?.position ?? Number.MAX_VALUE) - (order.get(b.story.id)?.position ?? Number.MAX_VALUE),
      )
      .map((f): StoryEntry => {
        const next = entries.find(
          (e) => e.storyId === f.story.id && e.itemId !== f.story.id && !e.held?.startsWith('Blocked by'),
        )?.itemId;
        return {
          storyId: f.story.id,
          projectId: f.story.projectId,
          inFlight: f.inFlight,
          parked: f.parked,
          started: f.started,
          maintenance: f.story.maintenance === true,
          shipped: f.tickets.length - f.unshipped.length,
          total: f.tickets.length,
          running: running(f),
          waiting: f.unshipped.filter((t) => waitsOnPerson(t)).map((t) => t.id),
          ...(next ? { next } : {}),
        };
      });
  };

  const state = (): SchedulerState => {
    const entries = queue();
    const projects = work.projects().filter((p) => ticketPool(p.id) !== undefined);
    return {
      paused: isPaused(),
      pools: [...poolSizes()].map(([name, size]): Pool => ({ name, size, active: activeIn(name) })),
      queue: entries,
      stories: storyEntries(entries),
      limits: {
        perProject: Object.fromEntries(work.projects().map((p) => [p.id, storyLimitOf(p.id)])),
        boxWide: projects.length ? boxCap(projects[0]!.id) : (poolSizes().get(DEFAULT_POOL) ?? 0),
      },
    };
  };

  const publish = () => bus.publish('scheduler.updated', state());

  const stageOf = (item: Item): Stage | undefined =>
    work.project(item.projectId)?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === item.stage);

  const hasRoom = (pools: string[]) => {
    const sizes = poolSizes();
    return pools.every((pool) => activeIn(pool) < (sizes.get(pool) ?? 0));
  };

  const launch = async (itemId: string, pools: string[]): Promise<SessionInfo> => {
    const item = work.item(itemId);
    if (item) joinOrder(itemId, item.projectId);
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
    // The queue is read again after every start: a start changes which Stories are in flight and
    // how many slots each holds.
    const skipped = new Set<string>();
    for (;;) {
      const entry = queue().find((e) => !skipped.has(e.itemId));
      if (!entry) break;
      skipped.add(entry.itemId);
      const pools = poolsOf(entry, entry.pool);
      if (blocked.has(entry.pool) || !hasRoom(pools)) continue;
      const item = work.item(entry.itemId);
      if (!item || item.stage !== entry.stage) {
        deleteEntry.run(entry.itemId);
        attended.delete(entry.itemId);
        work.setUpNext(entry.itemId, false);
        continue;
      }
      // Held by a guard, Blocked by, or the Story rules: it keeps its place, and the next entries may still start.
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
    } else if (event.type === 'widget.ready' || event.type === 'widget.approved' || event.type === 'ask.raised' || event.type === 'ask.answered') {
      // An Ask or its answer can park or unpark a Story.
      void dispatch();
    } else if (event.type === 'project.removed') {
      // An unregistered Project's Items leave Up next, so none starts if the folder is registered again.
      const { projectId } = (event as ProjectRemovedEvent).payload;
      for (const entry of queue().filter((e) => e.projectId === projectId)) {
        deleteEntry.run(entry.itemId);
        attended.delete(entry.itemId);
      }
      deleteProjectStories.run(projectId);
      publish();
    } else if (event.type === 'item.removed') {
      deleteStory.run((event as ItemRemovedEvent).payload.id);
    } else if (event.type === 'item.stage_changed' || event.type === 'item.rework') {
      // An Item entering a Stage that runs a Session (its Exit was met, or a Gate sent it back, maybe
      // to the Gate's own Stage) joins the queue by itself; nobody has to press Start.
      const { itemId, projectId } = (event as ItemStageChangedEvent).payload;
      // A Ticket changing Stage can ship, park or unpark its Story, or unblock another Ticket.
      if (event.type === 'item.stage_changed') void dispatch();
      const changed = work.item(itemId);
      if (changed?.kind === 'story' && changed.runState === 'shipped') deleteStory.run(itemId);
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
      joinOrder(itemId, item.projectId);
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
    // A person starting a Ticket does not skip the Story rules, only the guards for unattended work.
    const storyBlocked =
      item.kind === 'ticket' && (blockedHold(item) ?? storyHold(item, pool, storyFacts(), new Set())) !== undefined;
    if (!isPaused() && hasRoom(pools) && !waitingFirst && !storyBlocked && !heldBy({ itemId, projectId: item.projectId })) {
      attended.delete(itemId);
      const session = await launch(itemId, pools);
      publish();
      return { queued: false, session };
    }
    joinOrder(itemId, item.projectId);
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
    async setStoryLimit(projectId, limit) {
      if (!work.project(projectId)) throw new WorkError(404, `No Project "${projectId}"`);
      if (!Number.isInteger(limit) || limit < 0 || limit > MAX_STORY_LIMIT) {
        throw new WorkError(400, `Stories in flight is a whole number from 0 to ${MAX_STORY_LIMIT}`);
      }
      upsertLimit.run(projectId, limit);
      await dispatch();
      return state();
    },
    async reorder(order, projectId) {
      if (!Array.isArray(order)) throw new WorkError(400, 'Give the Up next order as a list of Story ids');
      const held = positions();
      const stories: string[] = [];
      for (const id of order) {
        const key = held.has(id) ? id : typeof id === 'string' && work.item(id) ? storyKeyOf(id) : id;
        if (!held.has(key)) throw new WorkError(409, `"${id}" is not waiting in Up next`);
        if (!stories.includes(key)) stories.push(key);
      }
      if (projectId !== undefined) {
        const other = stories.find((id) => held.get(id)!.projectId !== projectId);
        if (other) throw new WorkError(400, `"${other}" is not a Story of Project "${projectId}"`);
      }
      const next = new Map<string, number>();
      if (projectId === undefined) {
        // The listed Stories take the top places, above every unlisted one.
        const top = Math.min(0, ...[...held.values()].map((h) => h.position));
        stories.forEach((id, i) => next.set(id, top - stories.length + i));
      } else {
        // The listed Stories swap among the places they held, so other Projects' Stories stay put.
        const places = stories.map((id) => held.get(id)!.position).sort((a, b) => a - b);
        stories.forEach((id, i) => next.set(id, places[i]!));
      }
      db.exec('BEGIN');
      try {
        for (const [id, position] of next) setPosition.run(position, id);
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
