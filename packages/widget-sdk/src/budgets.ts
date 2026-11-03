// Budgets and usage records that cross the core API. A Budget is what a Session's usage draws from;
// every model belongs to exactly one Budget. Kiln records what Agents measured, per turn, and never
// estimates.
import type { KilnEvent } from './index.ts';

/** The Budget kinds. Ticket 15 builds `metered`; 17 adds `subscription`, 18 adds `local`. */
export type BudgetKindId = 'metered' | 'subscription' | 'local';

/** Money or credits, with a unit label and a rate to USD. */
export interface MeteredBudgetConfig {
  /** The unit costs are shown and capped in, e.g. "credits" or "USD". */
  unit: string;
  /** How many units one API-equivalent US dollar is (work: 50 credits per dollar). */
  ratePerUsd: number;
  /** Per calendar month (core's local time). */
  monthly: number;
  /** Per Session, counting its subagents: cost in the unit, and turns. */
  perSession: { cost: number; turns: number };
  /** Per Project per calendar day (core's local time). */
  perProjectPerDay: number;
}

/** The work install's defaults: 10,000 credits a month at 50 per dollar, 500 or 150 turns per Session, 1,250 per Project per day. */
export const METERED_DEFAULTS: MeteredBudgetConfig = {
  unit: 'credits',
  ratePerUsd: 50,
  monthly: 10_000,
  perSession: { cost: 500, turns: 150 },
  perProjectPerDay: 1_250,
};

/**
 * A flat plan like Claude Max, measured in plan usage: percent of each usage window, as the Agent's
 * quota readings report it. The windows are the 5-hour window, the week, and Fable's weekly allowance.
 */
export interface SubscriptionBudgetConfig {
  /** Per Session, counting its subagents: its share of the week (percent points), and turns. */
  perSession: { share: number; turns: number };
  /** The pace rule: no new unattended Session while weekly use is more than this many points ahead of the week elapsed. */
  paceAhead: number;
  /** Percent of each window kept for the person's own use. */
  reserve: number;
  /** The model label a model-scoped weekly reading carries for Fable (`QuotaReading.model`). */
  fableLabel: string;
  /** The Budget's models that run on Fable. Unset: any model whose id contains "fable". */
  fableModels?: string[];
}

/** Home's Claude Max defaults: 5% of the week or 150 turns per Session, the 10-point pace rule, 10% reserves. */
export const SUBSCRIPTION_DEFAULTS: SubscriptionBudgetConfig = {
  perSession: { share: 5, turns: 150 },
  paceAhead: 10,
  reserve: 10,
  fableLabel: 'Fable',
};

/** The usage windows a subscription Budget tracks. */
export type QuotaWindowId = '5h' | 'week' | 'fable';

export const QUOTA_WINDOWS: readonly { id: QuotaWindowId; name: string }[] = [
  { id: 'week', name: 'Week' },
  { id: '5h', name: '5-hour window' },
  { id: 'fable', name: 'Fable' },
];

/** One window of a subscription Budget, now. A window with no current reading is unknown and its rules are off. */
export interface QuotaWindowState {
  id: QuotaWindowId;
  name: string;
  known: boolean;
  /** 0-100 from the latest reading; null while unknown. */
  percent: number | null;
  resetsAt: string | null;
  /** When the latest reading was taken (also set when it has since gone out of date). */
  takenAt: string | null;
  /** The percent at which the reserve starts (100 minus the reserve). */
  reserveAt: number;
  /** True while the window is known and at or past its reserve. */
  atReserve: boolean;
  /** Week only: the share of the week elapsed (0-100), and whether use is ahead of pace by more than the rule allows. */
  pace?: number;
  aheadOfPace?: boolean;
  /** Short words, e.g. "Week: 42% used, pace 30%, resets in 2d 3h" or "5-hour window: unknown". */
  label: string;
}

/** A quota reading as Kiln stored it, with the Session it came from and the Budget it counts toward. */
export interface QuotaReadingRecord {
  id: number;
  /** When Kiln stored it, on Kiln's clock. */
  at: string;
  budgetId: string | null;
  sessionId: string;
  itemId: string;
  projectId: string;
  /** The window as the Agent named it. */
  window: string;
  model: string | null;
  /** The subscription window Kiln counts it toward, or null when it is none of them. */
  windowId: QuotaWindowId | null;
  percent: number | null;
  resetsAt: string | null;
  takenAt: string;
  source: string;
  usingOverage: boolean;
  usedCredits: number | null;
}

/**
 * `GET /api/usage/quota?budget=&window=&by=session|item|epic|project|stage|kind`: each key's share of
 * the window's measured changes, split across concurrent Sessions by tokens. Readings are
 * account-wide, so these are approximate.
 */
export interface QuotaRollup {
  key: string;
  window: QuotaWindowId;
  /** Percent points of the window. */
  percent: number;
  approximate: true;
}

/**
 * Models served on this machine (any OpenAI-compatible server, any OS or GPU). No money: a turn
 * costs one turn of the Session's cap, and each Session is also capped by wall time.
 */
export interface LocalBudgetConfig {
  /** Per Session, counting its subagents: turns, and minutes of wall time since it started. */
  perSession: { turns: number; minutes: number };
}

/** The home install's defaults: 300 turns or 2 hours per Session. */
export const LOCAL_DEFAULTS: LocalBudgetConfig = { perSession: { turns: 300, minutes: 120 } };

/** The capacity pool every Session on a local Budget takes a slot in, besides its Stage's pool. */
export const LOCAL_POOL = 'gpu';

/** The local pool's size until an Admin sets one: one local model at a time. */
export const LOCAL_POOL_SIZE = 1;

/** `PUT /api/budgets/:id` (Admin): creates or replaces a Budget. Kind-specific settings sit beside these. */
export interface SetBudgetRequest {
  kind: BudgetKindId;
  name?: string;
  /** The models that draw from this Budget. A model can belong to only one Budget (409 otherwise). */
  models: string[];
  /** Kind-specific settings; anything left out takes the kind's default. */
  [setting: string]: unknown;
}

/** One limit of a Budget, as it stands now. */
export interface BudgetLimitState {
  /** e.g. `month`, `project-day`, `session-cost`, `session-turns`. */
  id: string;
  name: string;
  used: number;
  cap: number;
  /** The unit `used` and `cap` count, e.g. "credits" or "turns". */
  unit: string;
  /** When the period ends and `used` starts again from zero (period limits only). */
  resetsAt?: string;
}

/** The header gauge for a Budget. */
export interface BudgetGauge {
  /** Short words for the gauge, e.g. "1,234 of 10,000 credits this month". */
  label: string;
  used: number;
  cap: number;
  unit: string;
  resetsAt?: string;
}

/** `GET /api/budgets`: a Budget with its settings and gauge. */
export interface BudgetInfo {
  id: string;
  kind: BudgetKindId;
  name: string;
  models: string[];
  /** The kind's settings (MeteredBudgetConfig for `metered`). */
  config: Record<string, unknown>;
  unit: string;
  gauge: BudgetGauge;
  /** Budget-wide limits (the monthly limit), now. */
  limits: BudgetLimitState[];
  /** True while a Budget-wide limit is reached: nothing new starts on it and its Sessions are paused. */
  held: boolean;
  /** Subscription Budgets: each usage window, now (the week first). */
  windows?: QuotaWindowState[];
}

/**
 * One turn, as Kiln stored it. A subagent's turn has its own `sessionId` (`<parent>/<subagent>`),
 * the Kiln Session in `parentSessionId` and the subagent's description.
 */
export interface UsageRecord {
  id: number;
  at: string;
  sessionId: string;
  parentSessionId: string | null;
  subagent: string | null;
  itemId: string;
  projectId: string;
  /** The Epic the Item sits under (or is), if any. */
  epicId: string | null;
  stage: string;
  itemKind: string;
  model: string | null;
  /** The Budget the turn's model belongs to, or null when the model is in none. */
  budgetId: string | null;
  turn: number;
  /** Input + cache reads + cache writes, unless the Agent reported it. */
  contextTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** In the Budget's unit; null when the Agent reported no cost (Kiln never estimates). */
  cost: number | null;
  unit: string | null;
  /** API-equivalent US dollars as the Agent reported them, for comparing across Budgets. */
  costUsd: number | null;
  /** Milliseconds since the previous turn of the same (sub)session, or since the Session started. */
  idleMs: number;
}

export type UsageGroup = 'session' | 'item' | 'epic' | 'project' | 'stage' | 'kind' | 'day' | 'week' | 'month';

export const USAGE_GROUPS: readonly UsageGroup[] = ['session', 'item', 'epic', 'project', 'stage', 'kind', 'day', 'week', 'month'];

/**
 * `GET /api/usage?by=<group>[&budget=][&project=][&item=][&from=][&to=]`: one row per group key and
 * Budget (units differ between Budgets). Subagent turns count toward their parent Session.
 */
export interface UsageRollup {
  /** The Session, Item, Epic or Project id, Stage id, Item kind, or `YYYY-MM-DD` / `YYYY-MM` (week: its Monday). */
  key: string;
  budgetId: string | null;
  unit: string | null;
  turns: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Sum of the turns' costs in the unit (turns with no cost add nothing). */
  cost: number;
  costUsd: number;
}

/** A warning (at half a cap) or a reached cap, shown on the Item. */
export interface UsageAlert extends BudgetLimitState {
  budgetId: string;
  level: 'warning' | 'reached';
}

/** Live usage of a Session (subagents included), on its Item's run. */
export interface SessionUsage {
  budgetId: string | null;
  unit: string | null;
  turns: number;
  cost: number;
  /** Input + output + cache tokens across every turn. */
  tokens: number;
  outputTokens: number;
  /** The latest main-thread turn's context size. */
  contextTokens: number;
  alerts: UsageAlert[];
}

/** `POST /api/test/clock` (test instances only): set the clock, or move it forward. */
export interface SetTestClockRequest {
  now?: string;
  advanceMs?: number;
}

export type UsageRecordedEvent = KilnEvent<'usage.recorded', { record: UsageRecord; itemId: string; projectId: string; sessionId: string }>;
export type QuotaRecordedEvent = KilnEvent<'quota.recorded', { reading: QuotaReadingRecord; itemId: string; projectId: string; sessionId: string }>;
/**
 * A subscription window rule fired: `reserve` (a window at its reserve), `overage` (paid usage
 * credits in use or rising), or `pace` (ahead of pace: new unattended starts hold).
 */
export type QuotaHoldEvent = KilnEvent<
  'quota.hold',
  { budgetId: string; rule: 'reserve' | 'overage' | 'pace'; window: QuotaWindowId; askIds: string[]; paused: string[]; itemId: string; projectId: string }
>;
/** A window rule lifted (the window reset, went unknown, or a person continued) and its Sessions were released. */
export type QuotaReleasedEvent = KilnEvent<'quota.released', { budgetId: string; rule: 'reserve' | 'overage'; window: QuotaWindowId; released: string[] }>;
/** Sent on every SSE connection and whenever usage, settings or holds change. */
export type BudgetsUpdatedEvent = KilnEvent<'budgets.updated', { budgets: BudgetInfo[] }>;
/** A cap was reached: the work it covers is paused and a blocking Ask is raised. */
export type BudgetLimitReachedEvent = KilnEvent<
  'budget.limit_reached',
  { budgetId: string; limit: BudgetLimitState; scope: 'session' | 'project' | 'budget'; itemId: string; projectId: string; askId: string; paused: string[] }
>;
