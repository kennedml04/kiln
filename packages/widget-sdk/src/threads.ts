// Types for Threads and Digests: a person's message into an Item's Thread, and the Digest every
// Session leaves behind in the Knowledge store.
import type { KilnEvent } from './index.ts';

/** `POST /api/items/:id/messages`: a person types into the Item's Thread. */
export interface ThreadMessageRequest {
  text: string;
}

/**
 * Where a Thread message went:
 * - `running`: into the Item's live Session (running, paused or waiting on an Ask).
 * - `resumed`: its last Session in this Stage had ended but its Agent's cache was still warm, so the
 *   same Session carries on with the message.
 * - `fresh`: a fresh Session for the current Stage started, seeded from artifacts and Digests, and
 *   got the message.
 * - `queued`: the fresh Session waits in Up next for room in its pool; it gets the message when it starts.
 */
export interface ThreadMessageResult {
  delivery: 'running' | 'resumed' | 'fresh' | 'queued';
  /** The Session that got the message (unset while queued). */
  sessionId?: string;
}

/**
 * What a Session records when it ends: what was decided, what changed and what is still open.
 * The `write_digest` Kiln tool takes this.
 */
export interface DigestContent {
  decided: string[];
  changed: string[];
  open: string[];
  /** Free text, e.g. an Agent's own summary. */
  summary?: string;
}

/**
 * A Digest as stored in the Knowledge store. A `rollup` replaces every Digest in `covers` when
 * seeding (it is written by Kiln once an Item's Digests pile up).
 */
export interface Digest extends DigestContent {
  id: string;
  kind: 'digest' | 'rollup';
  itemId: string;
  projectId: string;
  /** The Session that ended (null for a rollup). */
  sessionId: string | null;
  stage: string;
  /** `session`: the Agent wrote it with `write_digest`. `kiln`: the Session ended without one, or a rollup. */
  writtenBy: 'session' | 'kiln';
  writtenAt: string;
  /** Rollup only: the Digest ids it replaces (including an earlier rollup). */
  covers?: string[];
  /** The file, relative to the Knowledge store folder (forward slashes). */
  path: string;
}

export type DigestWrittenEvent = KilnEvent<'digest.written', { itemId: string; projectId: string; sessionId: string | null; digest: Digest }>;
