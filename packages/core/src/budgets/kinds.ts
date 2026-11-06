// Budget kinds: the extension point for what a Budget is. A kind turns a reported turn into a cost
// in its unit and names the limits that cap it; the usage service (usage.ts) measures every limit
// from the usage records, warns at half of it and pauses the work it covers when it is reached.
// Ticket 15 builds `metered`. Tickets 17 (`subscription`) and 18 (`local`) register their own kind
// with `registerBudgetKind`; a limit that is not a sum of records gives its own `used`.
import {
  METERED_DEFAULTS,
  SUBSCRIPTION_DEFAULTS,
  type BudgetGauge,
  type BudgetKindId,
  type MeteredBudgetConfig,
  type QuotaWindowId,
  type SubscriptionBudgetConfig,
} from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';

/**
 * What a limit covers once reached: one Session (subagents included), the Budget's work in one
 * Project, or all of the Budget's work. Project and Budget limits also hold new starts.
 */
export type LimitScope = 'session' | 'project' | 'budget';

/** The calendar period a limit counts over, in the core's local time. Unset: the Session's life. */
export type LimitPeriod = 'day' | 'month';

/** Where a limit is measured: the Session and Project a turn (or a start) belongs to, and now. */
export interface LimitTarget {
  budgetId: string;
  sessionId?: string;
  projectId?: string;
  now: Date;
}

export interface LimitSpec {
  /** Stable id, e.g. `month`, `project-day`, `session-cost`, `session-turns`. */
  id: string;
  /** Shown to people, e.g. "Monthly limit". */
  name: string;
  scope: LimitScope;
  period?: LimitPeriod;
  /**
   * Sum the records' cost (in the Budget's unit), count their turns, (Session limits only) the whole
   * minutes of wall time since the Session started, checked between turns too, or sum the target's
   * attributed share of a quota window's measured changes (`window`, in percent points; subscription
   * Budgets).
   */
  measure: 'cost' | 'turns' | 'minutes' | 'quota';
  window?: QuotaWindowId;
  cap: number;
  /** Measures the limit some other way (e.g. a subscription's quota reading). Unset: from the records. */
  used?: (target: LimitTarget) => number;
}

export interface BudgetKind<C = Record<string, unknown>> {
  id: BudgetKindId;
  /** Checks a `PUT /api/budgets/:id` body's kind settings, filling in defaults. Throws WorkError 400. */
  configure(input: Record<string, unknown>): C;
  /** The unit its costs are in, e.g. "credits". */
  unit(config: C): string;
  /** A turn's cost in the unit, or null when the Agent reported nothing to cost it by (never estimate). */
  turnCost(config: C, turn: { costUsd?: number; inputTokens: number; outputTokens: number }): number | null;
  /** Its limits. The first `budget`-scoped one is the header gauge. */
  limits(config: C): LimitSpec[];
  /**
   * Capacity pools its Sessions take a slot in besides their Stage's, with each pool's size until
   * an Admin sets one (local: `gpu: 1`). The pools exist while a Budget of this kind does.
   */
  pools?(config: C): Record<string, number>;
  /**
   * The header gauge when the kind has no `budget`-scoped limit (local: running Sessions). `running`
   * counts the Budget's running Sessions; `poolSize` reads a pool's current size.
   */
  gauge?(config: C, live: { running: number; poolSize: (name: string) => number }): BudgetGauge;
}

const kinds = new Map<string, BudgetKind>();

export function registerBudgetKind<C>(kind: BudgetKind<C>): void {
  kinds.set(kind.id, kind as unknown as BudgetKind);
}

export const budgetKind = (id: string): BudgetKind | undefined => kinds.get(id);

export const budgetKindIds = (): string[] => [...kinds.keys()];

const positive = (value: unknown, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new WorkError(400, `"${name}" must be a number above zero`);
  return value;
};

/** Money or credits: costs are the Agent's API-equivalent dollars at the Budget's rate. */
export const meteredKind: BudgetKind<MeteredBudgetConfig> = {
  id: 'metered',
  configure(input) {
    const d = METERED_DEFAULTS;
    const unit = input.unit ?? d.unit;
    if (typeof unit !== 'string' || !unit.trim()) throw new WorkError(400, '"unit" must be a name, e.g. "credits"');
    const perSession = (input.perSession ?? {}) as Record<string, unknown>;
    if (typeof perSession !== 'object') throw new WorkError(400, '"perSession" must be {cost, turns}');
    return {
      unit: unit.trim(),
      ratePerUsd: positive(input.ratePerUsd, 'ratePerUsd', d.ratePerUsd),
      monthly: positive(input.monthly, 'monthly', d.monthly),
      perSession: {
        cost: positive(perSession.cost, 'perSession.cost', d.perSession.cost),
        turns: positive(perSession.turns, 'perSession.turns', d.perSession.turns),
      },
      perProjectPerDay: positive(input.perProjectPerDay, 'perProjectPerDay', d.perProjectPerDay),
    };
  },
  unit: (config) => config.unit,
  turnCost: (config, turn) => (typeof turn.costUsd === 'number' ? turn.costUsd * config.ratePerUsd : null),
  limits: (config) => [
    { id: 'month', name: 'Monthly limit', scope: 'budget', period: 'month', measure: 'cost', cap: config.monthly },
    { id: 'project-day', name: 'Daily limit for this Project', scope: 'project', period: 'day', measure: 'cost', cap: config.perProjectPerDay },
    { id: 'session-cost', name: 'Session limit', scope: 'session', measure: 'cost', cap: config.perSession.cost },
    { id: 'session-turns', name: 'Session turn limit', scope: 'session', measure: 'turns', cap: config.perSession.turns },
  ],
};

registerBudgetKind(meteredKind);

const percentPoints = (value: unknown, name: string, fallback: number, { allowZero = false } = {}): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || value > 100) {
    throw new WorkError(400, `"${name}" must be percent points from ${allowZero ? 0 : 'above 0'} to 100`);
  }
  return value;
};

/**
 * A flat plan (Claude Max), measured in plan usage. Turns carry no cost in its unit: a Session's
 * quota cost is its attributed share of the windows' measured changes (quota.ts). The window rules
 * (pace, reserves, overage) live in subscription-rules.ts; these are the per-Session caps.
 */
export const subscriptionKind: BudgetKind<SubscriptionBudgetConfig> = {
  id: 'subscription',
  configure(input) {
    const d = SUBSCRIPTION_DEFAULTS;
    const perSession = (input.perSession ?? {}) as Record<string, unknown>;
    if (typeof perSession !== 'object') throw new WorkError(400, '"perSession" must be {share, turns}');
    const guard = (input.guard ?? {}) as Record<string, unknown>;
    if (typeof guard !== 'object' || guard === null) throw new WorkError(400, '"guard" must be {share, hours}');
    const hours = guard.hours ?? d.guard.hours;
    if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 168) {
      throw new WorkError(400, '"guard.hours" must be a whole number of hours from 1 to 168');
    }
    const label = input.fableLabel ?? d.fableLabel;
    if (typeof label !== 'string' || !label.trim()) throw new WorkError(400, '"fableLabel" must be the Fable window\'s model label');
    const fableModels = input.fableModels;
    if (fableModels !== undefined && (!Array.isArray(fableModels) || !fableModels.every((m) => typeof m === 'string' && m.trim()))) {
      throw new WorkError(400, '"fableModels" must list model ids');
    }
    return {
      perSession: {
        share: percentPoints(perSession.share, 'perSession.share', d.perSession.share),
        turns: positive(perSession.turns, 'perSession.turns', d.perSession.turns),
      },
      paceAhead: percentPoints(input.paceAhead, 'paceAhead', d.paceAhead, { allowZero: true }),
      reserve: percentPoints(input.reserve, 'reserve', d.reserve, { allowZero: true }),
      guard: { share: percentPoints(guard.share, 'guard.share', d.guard.share, { allowZero: true }), hours },
      fableLabel: label.trim(),
      ...(fableModels ? { fableModels: fableModels as string[] } : {}),
    };
  },
  unit: () => '% of week',
  turnCost: () => null,
  limits: (config) => [
    { id: 'session-share', name: 'Session share of the week', scope: 'session', measure: 'quota', window: 'week', cap: config.perSession.share },
    { id: 'session-turns', name: 'Session turn limit', scope: 'session', measure: 'turns', cap: config.perSession.turns },
  ],
};

registerBudgetKind(subscriptionKind);

/** Whether a model in a subscription Budget runs on Fable. */
export const onFable = (config: SubscriptionBudgetConfig, model: string | null | undefined) =>
  !!model && (config.fableModels ? config.fableModels.includes(model) : model.toLowerCase().includes('fable'));
