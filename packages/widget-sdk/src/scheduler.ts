// Scheduler types that cross the core API: capacity pools, the queue of Items waiting to start a
// Session (Up next), and Stop all.
import type { KilnEvent } from './index.ts';
import type { SessionInfo } from './flow.ts';

/** The pool a Stage uses when it names none. */
export const DEFAULT_POOL = 'agents';
export const DEFAULT_POOL_SIZE = 3;

/** A named capacity pool: at most `size` Sessions in Stages that use it run (or sit paused) at once. */
export interface Pool {
  name: string;
  size: number;
  /** Sessions holding a slot now (running or paused). */
  active: number;
}

/** One Item waiting in Up next for room in its Stage's pool. */
export interface QueueEntry {
  itemId: string;
  projectId: string;
  stage: string;
  pool: string;
  /** Higher starts first; ties go to the oldest entry. Set by dragging within Up next. */
  priority: number;
  enqueuedAt: string;
  /** Why it may not start yet although its pool has room, e.g. a Budget's daily cap is reached. */
  held?: string;
}

export interface SchedulerState {
  /** True after Stop all, until a person resumes: no Session starts and running ones are paused. */
  paused: boolean;
  pools: Pool[];
  /** In start order. */
  queue: QueueEntry[];
}

/** `POST /api/items/:id/start`: started now (201) or queued in Up next (202). */
export interface StartResult {
  queued: boolean;
  /** Set when the Session started at once. */
  session?: SessionInfo;
  /** Set when the Item waits in Up next. */
  entry?: QueueEntry;
}

/** `PUT /api/scheduler/queue`: Item ids in the order they should start. Ids left out keep their place after these. */
export interface ReorderQueueRequest {
  order: string[];
}

/** `PUT /api/scheduler/pools/:name` (Admin). */
export interface SetPoolSizeRequest {
  size: number;
}

/** Published whenever pools, the queue or the paused flag change; also sent on every SSE connection. */
export type SchedulerUpdatedEvent = KilnEvent<'scheduler.updated', SchedulerState>;
