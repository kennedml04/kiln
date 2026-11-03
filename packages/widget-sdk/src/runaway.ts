// Runaway guards that apply to every Budget kind (ticket 16): the stall rule and the context alarm.
import type { KilnEvent } from './index.ts';

/** `GET` and `PUT /api/runaway` (Admin): the thresholds. A PUT may name only the ones it changes. */
export interface RunawaySettings {
  /** Main-thread turns in a row with no new commit and no artifact change before a Session counts as stalled. */
  stallTurns: number;
  /** The same tool call with the same arguments this many times in a row counts as stalled. */
  repeatedToolCalls: number;
  /** The context alarm fires at the lower of this many tokens... */
  contextTokens: number;
  /** ...and this share (0 to 1) of the model's context window, when the Agent reports the window. */
  contextShare: number;
}

export const RUNAWAY_DEFAULTS: RunawaySettings = { stallTurns: 8, repeatedToolCalls: 3, contextTokens: 300_000, contextShare: 0.6 };

/** Why the stall rule fired: too many turns without progress, or one tool call repeated. */
export type StallRule = 'turns' | 'tool';

/** A Session stalled: it is paused (nothing is killed) and waits on a blocking Ask (Continue or Stop). */
export type SessionStalledEvent = KilnEvent<
  'session.stalled',
  { sessionId: string; itemId: string; projectId: string; rule: StallRule; detail: string; askId: string }
>;

/**
 * A Session's context passed the alarm: it ended with a Digest and the Item carries on in a fresh
 * Session seeded from its artifacts and Digests. No Ask is raised.
 */
export type ContextAlarmEvent = KilnEvent<
  'session.context_alarm',
  { sessionId: string; itemId: string; projectId: string; contextTokens: number; threshold: number }
>;
