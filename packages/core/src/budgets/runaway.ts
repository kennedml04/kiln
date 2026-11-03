// The runaway guards that apply to every Budget kind (ticket 16).
//   GET /api/runaway   RunawaySettings
//   PUT /api/runaway   Partial<RunawaySettings> (Admin) -> RunawaySettings; 400 for a bad value
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { RUNAWAY_DEFAULTS, type RunawaySettings, type StallRule } from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { EventBus } from '../events.ts';
import type { SessionManager } from '../flow/session-manager.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';

export interface RunawayGuard {
  settings(): RunawaySettings;
  setSettings(input: unknown): RunawaySettings;
  close(): void;
}

export interface RunawayGuardDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  sessions: SessionManager;
  asks: AskService;
  /** Starts the Item's next Session (through the scheduler), after the context alarm ended one. */
  enqueue(itemId: string): Promise<unknown>;
}

/** The context size a usage event reports: as given, else input plus cache reads and writes. */
const contextOf = (usage: { contextTokens?: number; inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) =>
  usage.contextTokens ?? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);

const KEY = 'runaway';
/** The hold the stall rule puts on a Session (see SessionManager.hold). */
const STALL_HOLD = 'runaway:stall';

/** JSON with object keys sorted, so the same arguments in any key order compare equal. */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/** What the stall rule tracks for one live Session. */
interface Watch {
  /** The last tool call (name and arguments) and how many times in a row it came. */
  lastCall?: string;
  repeats: number;
  /** What the Session had made at its last productive turn (SessionManager.progressMark). */
  mark?: string;
  /** Main-thread turns since then that made nothing. */
  idle: number;
  /** Whether a stall Ask is open for it. */
  stalled: boolean;
  /** Whether a main-thread turn was reported since the last unmet Exit check. */
  turnSinceCheck?: boolean;
}

/** Checks a PUT body against the current settings; throws 400 naming the first bad value. */
function mergeSettings(current: RunawaySettings, input: unknown): RunawaySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkError(400, 'Send the thresholds to change as an object');
  const body = input as Record<string, unknown>;
  const next = { ...current };
  for (const [key, value] of Object.entries(body)) {
    if (!(key in RUNAWAY_DEFAULTS)) throw new WorkError(400, `"${key}" is not a runaway setting`);
    const n = value as number;
    if (key === 'contextShare') {
      if (typeof n !== 'number' || !(n > 0 && n <= 1)) throw new WorkError(400, '"contextShare" is a share of the context window, above 0 and at most 1');
    } else if (!Number.isInteger(n) || n < 1) {
      throw new WorkError(400, `"${key}" must be a whole number of 1 or more`);
    }
    next[key as keyof RunawaySettings] = n;
  }
  return next;
}

export function createRunawayGuard({ db, bus, work, sessions, asks, enqueue }: RunawayGuardDeps): RunawayGuard {
  const select = db.prepare('SELECT value FROM core_settings WHERE key = ?');
  const upsert = db.prepare('INSERT INTO core_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

  const settings = (): RunawaySettings => {
    const row = select.get(KEY) as { value: string } | undefined;
    return { ...RUNAWAY_DEFAULTS, ...(row ? (JSON.parse(row.value) as Partial<RunawaySettings>) : {}) };
  };

  const watches = new Map<string, Watch>();
  const watch = (sessionId: string) => {
    let found = watches.get(sessionId);
    if (!found) watches.set(sessionId, (found = { repeats: 0, idle: 0, stalled: false }));
    return found;
  };
  /** Starts the counts over (a person's Continue). */
  const reset = (w: Watch) => {
    delete w.lastCall;
    w.repeats = 0;
    w.idle = 0;
  };
  /**
   * A main-thread turn, with what the Session had made when it was reported: it made something
   * (a commit or an artifact edit), or it counts toward the stall rule.
   */
  const onTurn = (sessionId: string, mark: string | undefined) => {
    const w = watch(sessionId);
    if (mark === undefined || w.stalled) return;
    if (mark !== w.mark) {
      w.mark = mark;
      w.idle = 0;
      return;
    }
    w.idle++;
    const limit = settings().stallTurns;
    if (w.idle >= limit) stall(sessionId, w, 'turns', `${w.idle} turns in a row with no new commit and no artifact change`);
  };

  /** Pauses a running Session (nothing is killed) and asks a person whether it should go on. */
  const stall = (sessionId: string, w: Watch, rule: StallRule, detail: string) => {
    const session = sessions.session(sessionId);
    if (!session || session.state !== 'running' || w.stalled) return;
    const title = work.item(session.itemId)?.title ?? session.itemId;
    w.stalled = true;
    const ask = asks.raise({
      type: 'decision',
      question: `${title}: the ${session.role} looks stuck (${detail}). Continue it?`,
      why: 'Kiln paused the Session so a loop does not burn money or quota; nothing was stopped. Continue lets it go on; Stop ends it.',
      recommendation: 'Stop',
      options: ['Continue', 'Stop'],
      blocking: true,
      itemId: session.itemId,
      raisedBy: { kind: 'runaway', sessionId },
    });
    sessions.hold(sessionId, STALL_HOLD);
    bus.publish('session.stalled', { sessionId, itemId: session.itemId, projectId: session.projectId, rule, detail, askId: ask.id });
  };

  asks.setRecipient('runaway', {
    reaches: (raiser) => raiser.kind === 'runaway' && sessions.active().some((s) => s.id === raiser.sessionId),
    deliver(ask) {
      if (ask.raisedBy.kind !== 'runaway') return;
      const { sessionId } = ask.raisedBy;
      const w = watch(sessionId);
      w.stalled = false;
      reset(w);
      if (ask.answer === 'Continue') sessions.release(sessionId, STALL_HOLD);
      else sessions.stop(sessionId);
    },
  });

  /** Sessions the context alarm is ending, so one alarm is raised per Session. */
  const renewing = new Set<string>();

  /**
   * Past the context threshold (the lower of the token setting and the share of the model's window,
   * when the Agent reports it): the Session ends with a Digest and the Item goes on in a fresh
   * Session seeded from its artifacts and Digests. Nobody is asked.
   */
  const onContext = (sessionId: string, contextTokens: number, contextWindow: number | undefined) => {
    const { contextTokens: cap, contextShare } = settings();
    const threshold = Math.min(cap, contextWindow ? Math.floor(contextWindow * contextShare) : Infinity);
    if (contextTokens <= threshold || renewing.has(sessionId)) return;
    const session = sessions.session(sessionId);
    if (!session || session.state !== 'running') return;
    renewing.add(sessionId);
    bus.publish('session.context_alarm', { sessionId, itemId: session.itemId, projectId: session.projectId, contextTokens, threshold });
    const reason = `The context alarm ended the Session at ${contextTokens} context tokens (threshold ${threshold}); a fresh Session goes on from the artifacts and Digests.`;
    void sessions
      .renew(sessionId, reason)
      .then((ended) => (ended ? enqueue(session.itemId) : undefined))
      .catch(() => {
        // The fresh Session could not start (Stop all, a Budget, no slot): the Item waits, as any
        // other start the scheduler refuses.
      })
      .finally(() => renewing.delete(sessionId));
  };

  const onToolCall =(sessionId: string, tool: { name: string; input?: unknown }) => {
    const w = watch(sessionId);
    if (w.stalled) return;
    const call = `${tool.name} ${stableJson(tool.input ?? null)}`;
    w.repeats = call === w.lastCall ? w.repeats + 1 : 1;
    w.lastCall = call;
    const limit = settings().repeatedToolCalls;
    if (w.repeats >= limit) stall(sessionId, w, 'tool', `the same ${tool.name} call ${w.repeats} times in a row: ${stableJson(tool.input ?? null)}`);
  };

  const unsubscribe = bus.subscribe((event) => {
    const payload = event.payload as { sessionId?: string; tool?: { name: string; input?: unknown }; subagent?: unknown };
    if (!payload?.sessionId) return;
    const { sessionId } = payload;
    // What the guard publishes comes after the publishing listener loop (a microtask), so it follows
    // the event on every stream. What the Session has made is read at once, as the turn arrives.
    if (event.type === 'session.started') {
      // Where the Session starts from: its first turns are measured against this.
      watch(sessionId).mark = sessions.progressMark(sessionId);
    } else if (event.type === 'session.usage' && !payload.subagent) {
      // A subagent's turns are work under the main thread's turn, which is what the rule counts.
      const mark = sessions.progressMark(sessionId);
      watch(sessionId).turnSinceCheck = true;
      const usage = payload as { contextWindow?: number };
      const context = contextOf(payload as Parameters<typeof contextOf>[0]);
      queueMicrotask(() => {
        onContext(sessionId, context, usage.contextWindow);
        if (!renewing.has(sessionId)) onTurn(sessionId, mark);
      });
    } else if (event.type === 'exit.checked' && !(payload as { exit?: { met?: boolean } }).exit?.met) {
      // An Agent that keeps saying it is done without meeting the Exit: each unmet check is a turn,
      // unless the Agent reported its turns itself (they were counted already).
      const w = watch(sessionId);
      const counted = w.turnSinceCheck;
      w.turnSinceCheck = false;
      if (!counted) {
        const mark = sessions.progressMark(sessionId);
        queueMicrotask(() => onTurn(sessionId, mark));
      }
    } else if (event.type === 'session.progress' && payload.tool?.name) {
      const tool = payload.tool;
      queueMicrotask(() => onToolCall(sessionId, tool));
    } else if (event.type === 'session.updated') {
      const { state } = (payload as { session: { state: string } }).session;
      if (!['running', 'paused', 'waiting'].includes(state)) watches.delete(payload.sessionId);
    }
  });

  return {
    settings,
    setSettings(input) {
      const next = mergeSettings(settings(), input);
      upsert.run(KEY, JSON.stringify(next));
      return next;
    },
    close: unsubscribe,
  };
}

/** Answers the request if it is a runaway route; returns false otherwise. */
export async function handleRunawayRoute(
  guard: RunawayGuard,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  if (url.pathname !== '/api/runaway') return false;
  try {
    if (req.method === 'GET') return (sendJson(res, 200, guard.settings()), true);
    if (req.method === 'PUT') return (sendJson(res, 200, guard.setSettings(await readJson(req))), true);
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
