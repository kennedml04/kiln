// Scheduler types that cross the core API: capacity pools, the queue of Items waiting to start a
// Session (Up next), and Stop all.
import type { KilnEvent } from './index.ts';
import type { SessionInfo } from './flow.ts';

/** The pool a Stage uses when it names none. */
export const DEFAULT_POOL = 'agents';
export const DEFAULT_POOL_SIZE = 3;
/** Stories in flight per Project when none is set. */

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
  /** No longer used for ordering (Story order is); always 0 for entries made now. */
  priority: number;
  enqueuedAt: string;
  /** The Story the Item belongs to (the Story itself for its own entry); unset for an Item with no Story. */
  storyId?: string;
  /** Why it may not start yet although its pool has room, e.g. a Budget's daily cap is reached. */
  held?: string;
}

/** The Stories per Project that may be in flight at once when an Admin sets none. */
export const DEFAULT_STORY_LIMIT = 2;
export const MAX_STORY_LIMIT = 10;

/** One Story with work waiting, running or parked, as the scheduler sees it. */
export interface StoryEntry {
  storyId: string;
  projectId: string;
  /** Holds a Story slot: started, has unshipped Tickets and is not parked. */
  inFlight: boolean;
  /** Started, and every unshipped Ticket waits on a person: it holds no slot. */
  parked: boolean;
  /** At least one of its Tickets has had a Session. */
  started: boolean;
  maintenance: boolean;
  /** Tickets shipped, of `total`. */
  shipped: number;
  total: number;
  /** Tickets with a Session running now. */
  running: string[];
  /** Tickets waiting on a person. */
  waiting: string[];
  /** The Ticket that will start next, if any. */
  next?: string;
}

export interface SchedulerState {
  /** True after Stop all, until a person resumes: no Session starts and running ones are paused. */
  paused: boolean;
  pools: Pool[];
  /** In start order. */
  queue: QueueEntry[];
  /** Stories with work waiting, running or parked, in the start order dispatch uses. */
  stories: StoryEntry[];
  /** Stories in flight at once: per Project (default 2), and across the box (the Ticket Stage's pool size). */
  limits: StoryLimits;
}

/** `POST /api/items/:id/start`: started now (201) or queued in Up next (202). */
export interface StartResult {
  queued: boolean;
  /** Set when the Session started at once. */
  session?: SessionInfo;
  /** Set when the Item waits in Up next. */
  entry?: QueueEntry;
}

/**
 * `PUT /api/scheduler/queue`: Story ids in the order they should start. Ids left out keep their place
 * after these. Ticket ids are accepted until the next release and move their Story.
 */
export interface ReorderQueueRequest {
  order: string[];
  /** Reorder only this Project's Stories, within the positions they already hold (400 for other Projects' Stories). */
  projectId?: string;
}

/** `PUT /api/scheduler/pools/:name` (Admin). */
export interface SetPoolSizeRequest {
  size: number;
}

/** `PUT /api/scheduler/story-limits/:projectId` (Admin): a whole number from 0 to 10. */
export interface SetStoryLimitRequest {
  limit: number;
}

/** Published whenever pools, the queue or the paused flag change; also sent on every SSE connection. */
export type SchedulerUpdatedEvent = KilnEvent<'scheduler.updated', SchedulerState>;

/** How many Stories may be in flight: per Project, and across the box (the Ticket kind's first-Stage pool size). */
export interface StoryLimits {
  perProject: Record<string, number>;
  boxWide: number;
}
