// The usage service: Budgets, usage records and the caps.
//
// Every turn an Agent reports (`session.usage`) becomes one usage record, costed by the Budget its
// model belongs to (never estimated). After each turn the Budget's limits are measured: at half a
// cap the Item shows a warning; at the cap the work it covers is paused (nothing is killed) and a
// blocking Ask is raised. "Continue" allows one more cap's worth for that scope and period; "Stop"
// stops the paused Sessions. A reached Project or Budget limit also holds new starts (the
// scheduler's start guard) until its period rolls over or a person continues.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  Ask,
  BudgetInfo,
  BudgetLimitState,
  Item,
  QuotaReadingRecord,
  QuotaRollup,
  QuotaWindowId,
  SubscriptionBudgetConfig,
  SessionAgentEvent,
  SessionStartedEvent,
  SessionUpdatedEvent,
  SessionUsage,
  UsageAlert,
  UsageGroup,
  UsageRecord,
  UsageRollup,
} from '@kiln/widget-sdk';
import { QUOTA_WINDOWS, USAGE_GROUPS } from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { Clock } from '../clock.ts';
import type { EventBus } from '../events.ts';
import type { DoctorCheck } from '../operations/doctor.ts';
import type { SessionManager } from '../flow/session-manager.ts';
import { WorkError, type Work } from '../work/work.ts';
import { budgetKind, budgetKindIds, type LimitScope, type LimitSpec } from './kinds.ts';
import { createQuotaStore } from './quota.ts';
import { createStageModels } from './stage-models.ts';
import { createSubscriptionRules, type SubscriptionBudget } from './subscription-rules.ts';
import { dayKey, monthKey, periodEnd, periodKey, weekKey } from './periods.ts';
import './local.ts';

export interface UsageService {
  budgets(): BudgetInfo[];
  /** Creates or replaces a Budget. 400 for bad settings, 409 when a model already belongs to another Budget. */
  setBudget(id: string, input: unknown): BudgetInfo;
  removeBudget(id: string): void;
  records(filter: { session?: string; item?: string }): UsageRecord[];
  rollup(by: string, filter: { budget?: string; project?: string; item?: string; from?: string; to?: string }): UsageRollup[];
  /** Quota readings as stored (subscription Budgets). */
  quotaReadings(filter: { budget?: string; session?: string }): QuotaReadingRecord[];
  /** A subscription window's measured changes, attributed by `by`. 400/404 for a bad Budget or window. */
  quotaRollup(by: string, filter: { budget?: string; window?: string }): QuotaRollup[];
  /** The scheduler's start guard: why this Item may not start now, or undefined. */
  startHold(entry: { itemId: string; projectId: string; attended?: boolean }): string | undefined;
  /** The scheduler's enqueue (Fable Sessions moved to a fallback model start again through it). */
  setEnqueue(enqueue: (itemId: string) => Promise<unknown>): void;
  /** The pools Budget kinds bring (local: `gpu: 1`), for the scheduler; the smaller size holds. */
  pools(): Record<string, number>;
  /** The scheduler's pool claim: the pools this Item's Budget takes a slot in besides its Stage's. */
  poolsFor(entry: { itemId: string; projectId: string }): string[];
  doctorCheck: DoctorCheck;
  close(): void;
}

interface BudgetRow {
  id: string;
  kind: string;
  name: string;
  config: string;
  models: string;
}

interface Budget {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  models: string[];
}

interface RecordRow {
  id: number;
  at: string;
  session_id: string;
  parent_session_id: string | null;
  subagent: string | null;
  item_id: string;
  project_id: string;
  epic_id: string | null;
  stage: string;
  item_kind: string;
  model: string | null;
  budget_id: string | null;
  turn: number;
  context_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost: number | null;
  unit: string | null;
  cost_usd: number | null;
  idle_ms: number;
}

/** A reached cap and the Sessions it paused, until its Ask is answered. */
interface Hold {
  key: string;
  budgetId: string;
  limitId: string;
  scope: LimitScope;
  scopeKey: string;
  period: string;
  grant: number;
  askId: string;
  sessions: Set<string>;
}

const GROUP_COLUMN: Record<UsageGroup, string> = {
  session: 'COALESCE(parent_session_id, session_id)',
  item: 'item_id',
  epic: 'epic_id',
  project: 'project_id',
  stage: 'stage',
  kind: 'item_kind',
  day: 'day',
  week: 'week',
  month: 'month',
};

const SCOPE_COLUMN: Record<LimitScope, string> = {
  session: 'COALESCE(parent_session_id, session_id)',
  project: 'project_id',
  budget: 'budget_id',
};

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

const fromRecordRow = (r: RecordRow): UsageRecord => ({
  id: r.id,
  at: r.at,
  sessionId: r.session_id,
  parentSessionId: r.parent_session_id,
  subagent: r.subagent,
  itemId: r.item_id,
  projectId: r.project_id,
  epicId: r.epic_id,
  stage: r.stage,
  itemKind: r.item_kind,
  model: r.model,
  budgetId: r.budget_id,
  turn: r.turn,
  contextTokens: r.context_tokens,
  inputTokens: r.input_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  outputTokens: r.output_tokens,
  cost: r.cost,
  unit: r.unit,
  costUsd: r.cost_usd,
  idleMs: r.idle_ms,
});

export interface UsageServiceDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  sessions: SessionManager;
  asks: AskService;
  clock: Clock;
  /** Asks the scheduler to try its queue again (a start guard may have lifted). */
  poke: () => void;
  /** A capacity pool's current size (for gauges that count against a pool, e.g. local's gpu). */
  poolSize?: (name: string) => number;
}

export function createUsageService({ db, bus, work, sessions, asks, clock, poke, poolSize = () => 0 }: UsageServiceDeps): UsageService {
  const selectBudgets = db.prepare('SELECT * FROM budgets ORDER BY id');
  const upsertBudget = db.prepare(
    `INSERT INTO budgets (id, kind, name, config, models) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, config = excluded.config, models = excluded.models`,
  );
  const deleteBudget = db.prepare('DELETE FROM budgets WHERE id = ?');
  const insertRecord = db.prepare(
    `INSERT INTO usage_records (at, session_id, parent_session_id, subagent, item_id, project_id, epic_id, stage, item_kind, model,
       budget_id, turn, context_tokens, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost, unit, cost_usd,
       idle_ms, day, week, month)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRecord = db.prepare('SELECT * FROM usage_records WHERE id = ?');
  const selectAllowance = db.prepare('SELECT extra FROM budget_allowances WHERE budget_id = ? AND limit_id = ? AND scope_key = ? AND period = ?');
  const addAllowance = db.prepare(
    `INSERT INTO budget_allowances (budget_id, limit_id, scope_key, period, extra) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (budget_id, limit_id, scope_key, period) DO UPDATE SET extra = extra + excluded.extra`,
  );
  const sessionTotals = db.prepare(
    `SELECT COUNT(*) AS turns,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(CASE WHEN budget_id IS ? THEN cost END), 0) AS cost
     FROM usage_records WHERE COALESCE(parent_session_id, session_id) = ?`,
  );
  const latestContext = db.prepare('SELECT context_tokens FROM usage_records WHERE session_id = ? ORDER BY id DESC LIMIT 1');
  const unbudgetedModels = db.prepare('SELECT DISTINCT model FROM usage_records WHERE budget_id IS NULL AND model IS NOT NULL ORDER BY model');
  const quota = createQuotaStore(db, clock);

  /** One measuring query per scope and period. */
  const usedQueries = new Map<string, StatementSync>();
  const usedQuery = (scope: LimitScope, period?: string) => {
    const key = `${scope}/${period ?? ''}`;
    let query = usedQueries.get(key);
    if (!query) {
      const periodClause = period ? ` AND ${period} = ?` : '';
      query = db.prepare(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS turns FROM usage_records
         WHERE budget_id = ? AND ${SCOPE_COLUMN[scope]} = ?${periodClause}`,
      );
      usedQueries.set(key, query);
    }
    return query;
  };

  const loadBudgets = (): Budget[] =>
    (selectBudgets.all() as unknown as BudgetRow[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      config: JSON.parse(r.config) as Record<string, unknown>,
      models: JSON.parse(r.models) as string[],
    }));
  const budgetById = (id: string | null | undefined) => (id ? loadBudgets().find((b) => b.id === id) : undefined);
  const budgetForModel = (model: string | null | undefined) => (model ? loadBudgets().find((b) => b.models.includes(model)) : undefined);

  /** Which Budget each live Session draws from: its latest main-thread turn's model's, else its start model's. */
  const drawsFrom = new Map<string, string | null>();
  /** When each Session started and each (sub)session's last turn, on Kiln's clock (for idle gaps). */
  const startedAt = new Map<string, number>();
  const lastTurnAt = new Map<string, number>();
  const holds = new Map<string, Hold>();
  /** When a Session started on Kiln's clock (its stored start time if it began before this service). */
  const sessionStart = (id: string): number => {
    const known = startedAt.get(id) ?? Date.parse(sessions.session(id)?.startedAt ?? '');
    return Number.isNaN(known) ? clock.now().getTime() : known;
  };

  const scopeKey = (scope: LimitScope, target: { budgetId: string; sessionId?: string; projectId?: string }) =>
    scope === 'session' ? target.sessionId : scope === 'project' ? target.projectId : target.budgetId;

  interface Measured {
    spec: LimitSpec;
    scopeKey: string;
    period: string;
    used: number;
    cap: number;
    state: BudgetLimitState;
  }

  /** Measures a Budget's limits that apply to the target (limits whose scope the target lacks are skipped). */
  const measure = (budget: Budget, target: { sessionId?: string; projectId?: string }, scopes?: LimitScope[]): Measured[] => {
    const kind = budgetKind(budget.kind);
    if (!kind) return [];
    const now = clock.now();
    const unit = kind.unit(budget.config);
    const out: Measured[] = [];
    for (const spec of kind.limits(budget.config)) {
      if (scopes && !scopes.includes(spec.scope)) continue;
      const key = scopeKey(spec.scope, { budgetId: budget.id, ...target });
      if (!key) continue;
      const period = spec.period ? periodKey(spec.period, now) : '';
      let used: number;
      if (spec.used) used = spec.used({ budgetId: budget.id, ...target, now });
      else if (spec.measure === 'quota') {
        // Only Session-scoped quota shares exist so far (the per-Session share of the week).
        used = spec.scope === 'session' && target.sessionId ? quota.sessionShare(budget.id, budget.config as unknown as SubscriptionBudgetConfig, spec.window ?? 'week', target.sessionId) : 0;
      } else if (spec.measure === 'minutes') used = Math.floor(Math.max(0, now.getTime() - sessionStart(key)) / 60_000);
      else {
        const args: string[] = [budget.id, key];
        if (spec.period) args.push(period);
        const row = usedQuery(spec.scope, spec.period).get(...args) as { cost: number; turns: number };
        used = spec.measure === 'turns' ? row.turns : row.cost;
      }
      const extra = (selectAllowance.get(budget.id, spec.id, key, period) as { extra: number } | undefined)?.extra ?? 0;
      const cap = spec.cap + extra;
      out.push({
        spec,
        scopeKey: key,
        period,
        used,
        cap,
        state: {
          id: spec.id,
          name: spec.name,
          used,
          cap,
          unit: spec.measure === 'cost' ? unit : spec.measure === 'quota' ? `% of ${spec.window ?? 'week'} (approximate)` : spec.measure,
          ...(spec.period ? { resetsAt: periodEnd(spec.period, now).toISOString() } : {}),
        },
      });
    }
    return out;
  };

  const info = (budget: Budget): BudgetInfo => {
    const kind = budgetKind(budget.kind);
    const unit = kind?.unit(budget.config) ?? '';
    const limits = measure(budget, {}, ['budget']);
    const gauge = limits[0];
    if (budget.kind === 'subscription') {
      // The header shows the windows; the gauge is the week's (or says it is unknown).
      const windows = quota.windows(budget.id, subscriptionConfig(budget));
      const weekly = windows.find((w) => w.id === 'week')!;
      return {
        id: budget.id,
        kind: 'subscription',
        name: budget.name,
        models: budget.models,
        config: budget.config,
        unit,
        gauge: {
          label: weekly.label,
          used: weekly.percent ?? 0,
          cap: weekly.known ? 100 : 0,
          unit,
          ...(weekly.resetsAt ? { resetsAt: weekly.resetsAt } : {}),
        },
        limits: [],
        windows,
        held: rules.held(budget.id),
      };
    }
    const running = () => sessions.active().filter((s) => s.state === 'running' && drawsFrom.get(s.id) === budget.id).length;
    const kindGauge = !gauge && kind?.gauge ? kind.gauge(budget.config, { running: running(), poolSize }) : undefined;
    return {
      id: budget.id,
      kind: budget.kind as BudgetInfo['kind'],
      name: budget.name,
      models: budget.models,
      config: budget.config,
      unit,
      gauge: gauge
        ? {
            label: `${fmt(gauge.used)} of ${fmt(gauge.cap)} ${gauge.state.unit} this ${gauge.spec.period ?? 'period'}`,
            used: gauge.used,
            cap: gauge.cap,
            unit: gauge.state.unit,
            ...(gauge.state.resetsAt ? { resetsAt: gauge.state.resetsAt } : {}),
          }
        : (kindGauge ?? { label: `No limit (${unit})`, used: 0, cap: 0, unit }),
      limits: limits.map((l) => l.state),
      held: limits.some((l) => l.used >= l.cap),
    };
  };

  const list = () => loadBudgets().map(info);
  const publishBudgets = () => bus.publish('budgets.updated', { budgets: list() });

  /** The live usage a Session shows on its Item: its totals plus the limits at half or more. */
  const sessionUsage = (sessionId: string, projectId: string): SessionUsage => {
    const budget = budgetById(drawsFrom.get(sessionId));
    const totals = sessionTotals.get(budget?.id ?? null, sessionId) as { turns: number; tokens: number; output: number; cost: number };
    const context = (latestContext.get(sessionId) as { context_tokens: number } | undefined)?.context_tokens ?? 0;
    const alerts: UsageAlert[] = budget
      ? measure(budget, { sessionId, projectId })
          .filter((m) => m.used >= m.cap / 2)
          .map((m) => ({ ...m.state, budgetId: budget.id, level: m.used >= m.cap ? 'reached' : 'warning' }))
      : [];
    return {
      budgetId: budget?.id ?? null,
      unit: budget ? (budgetKind(budget.kind)?.unit(budget.config) ?? null) : null,
      turns: totals.turns,
      cost: totals.cost,
      tokens: totals.tokens,
      outputTokens: totals.output,
      contextTokens: context,
      alerts,
    };
  };

  /** The live Sessions a reached limit covers. */
  const covered = (scope: LimitScope, budgetId: string, key: string) =>
    sessions
      .active()
      .filter((s) =>
        scope === 'session' ? s.id === key : drawsFrom.get(s.id) === budgetId && (scope === 'budget' || s.projectId === key),
      )
      .map((s) => s.id);

  const holdKey = (budgetId: string, m: Measured) => [budgetId, m.spec.id, m.scopeKey, m.period].join('\u0000');

  /** Needs you counts every Item and Session a hold paused against its Ask. */
  const countWaiting = (hold: Hold) =>
    asks.setWaiting(hold.askId, {
      itemIds: [...hold.sessions].flatMap((id) => sessions.session(id)?.itemId ?? []),
      sessions: hold.sessions.size,
    });

  const reach = (budget: Budget, m: Measured, itemId: string, projectId: string) => {
    const key = holdKey(budget.id, m);
    const existing = holds.get(key);
    if (existing) {
      // Work that joined the scope since (e.g. another Session in the Project) pauses too.
      const before = existing.sessions.size;
      for (const id of covered(m.spec.scope, budget.id, m.scopeKey)) {
        if (existing.sessions.has(id)) continue;
        existing.sessions.add(id);
        sessions.hold(id, key);
      }
      if (existing.sessions.size !== before) countWaiting(existing);
      return;
    }
    const paused = covered(m.spec.scope, budget.id, m.scopeKey);
    const unit = m.state.unit;
    const grant = m.spec.cap;
    const what = m.spec.scope === 'session' ? 'this Session' : m.spec.scope === 'project' ? `${budget.name} work in this Project` : `all ${budget.name} work`;
    const ask: Ask = asks.raise({
      type: 'decision',
      question: `${budget.name}: ${m.spec.name} reached (${fmt(m.used)} of ${fmt(m.cap)} ${unit}). Continue ${what}?`,
      why:
        `Kiln paused ${what}; nothing was stopped. Continue allows another ${fmt(grant)} ${unit}` +
        `${m.spec.period ? ` this ${m.spec.period}` : ''}; Stop ends the paused Sessions.`,
      recommendation: 'Stop',
      options: ['Continue', 'Stop'],
      blocking: true,
      itemId,
      raisedBy: { kind: 'budget', budgetId: budget.id },
    });
    const hold: Hold = {
      key,
      budgetId: budget.id,
      limitId: m.spec.id,
      scope: m.spec.scope,
      scopeKey: m.scopeKey,
      period: m.period,
      grant,
      askId: ask.id,
      sessions: new Set(paused),
    };
    holds.set(key, hold);
    for (const id of paused) sessions.hold(id, key);
    countWaiting(hold);
    bus.publish('budget.limit_reached', { budgetId: budget.id, limit: m.state, scope: m.spec.scope, itemId, projectId, askId: ask.id, paused });
  };

  /**
   * The Decision Asks for Items held because their Session would run on no model, or on one in no
   * Budget: one per Item and model, raised once until answered.
   */
  const unplannedAsks = new Map<string, string>();
  const UNPLANNED_RETRY = 'I fixed it: try again';
  const unplanned = (itemId: string, model: string | undefined) => {
    const key = `${itemId}\u0000${model ?? ''}`;
    if (!unplannedAsks.has(key)) {
      unplannedAsks.set(key, '');
      // Raised after the guard returns: the scheduler asks its guards while it builds its state.
      queueMicrotask(() => {
        const ask = asks.raise({
          type: 'decision',
          question: model
            ? `The model "${model}" is in no Budget, so Kiln won't start this Session on it. Add it to a Budget?`
            : "This Session's Stage names no model, and neither does its Agent, so Kiln won't start it.",
          why: model
            ? `Every model draws from exactly one Budget, so that Budget's caps cover it. Add "${model}" to a Budget's models ` +
              '(the setup wizard\'s Budgets step, or PUT /api/budgets/:id), or move the Stage to a model that has one. ' +
              'The Item starts by itself once its model has a Budget.'
            : "Kiln never runs a Session on an Agent tool's own default model. Name the Stage's model in the Project's " +
              '.kiln/workflow.json (or choose the role\'s model in the setup wizard), or use an Agent that registers a model.',
          recommendation: UNPLANNED_RETRY,
          options: [UNPLANNED_RETRY],
          blocking: true,
          itemId,
          raisedBy: { kind: 'budget', budgetId: budgetForModel(model)?.id ?? '' },
        });
        unplannedAsks.set(key, ask.id);
      });
    }
    return model ? `The model "${model}" is in no Budget` : 'The Session would run on no model';
  };
  /** The Item's model is fixed: its open Asks about it are answered for the person. */
  const settleUnplanned = (itemId: string) => {
    for (const [key, askId] of unplannedAsks) {
      if (!key.startsWith(`${itemId}\u0000`) || !askId) continue;
      unplannedAsks.delete(key);
      queueMicrotask(() => {
        if (asks.get(askId)?.state === 'open') asks.answer(askId, UNPLANNED_RETRY, { kind: 'kiln' });
      });
    }
  };

  asks.setRecipient('budget', {
    reaches: (raiser) => raiser.kind === 'budget',
    deliver(ask) {
      const unplannedKey = [...unplannedAsks].find(([, id]) => id === ask.id)?.[0];
      if (unplannedKey !== undefined) {
        // Asked again on the next try if it is still not fixed.
        unplannedAsks.delete(unplannedKey);
        poke();
        return;
      }
      const hold = [...holds.values()].find((h) => h.askId === ask.id);
      if (!hold) {
        rules.deliver(ask);
        return;
      }
      holds.delete(hold.key);
      if (ask.answer === 'Continue') {
        addAllowance.run(hold.budgetId, hold.limitId, hold.scopeKey, hold.period, hold.grant);
        for (const id of hold.sessions) sessions.release(id, hold.key);
      } else {
        for (const id of hold.sessions) sessions.stop(id);
      }
      for (const id of hold.sessions) {
        const s = sessions.session(id);
        if (s) sessions.noteUsage(id, sessionUsage(id, s.projectId));
      }
      publishBudgets();
      poke();
    },
  });

  /** The Epic an Item is or sits under. */
  const epicOf = (item: Item | undefined): string | null => {
    for (let at = item; at; at = at.parentId ? work.item(at.parentId) : undefined) if (at.kind === 'epic') return at.id;
    return null;
  };

  const record = (event: SessionAgentEvent<'usage'>['payload']) => {
    const session = sessions.session(event.sessionId);
    if (!session) return;
    const item = work.item(event.itemId);
    const now = clock.now();
    const at = now.getTime();
    const sub = event.subagent ? `${session.id}/${event.subagent.id ?? event.subagent.description}` : session.id;
    const model = event.model ?? session.model ?? null;
    const budget = budgetForModel(model);
    const kind = budget ? budgetKind(budget.kind) : undefined;
    const cost = budget && kind ? kind.turnCost(budget.config, event) : null;
    const previous = lastTurnAt.get(sub) ?? startedAt.get(session.id) ?? Date.parse(session.startedAt);
    lastTurnAt.set(sub, at);
    const cacheRead = event.cacheReadTokens ?? 0;
    const cacheWrite = event.cacheWriteTokens ?? 0;
    const result = insertRecord.run(
      now.toISOString(),
      sub,
      event.subagent ? session.id : null,
      event.subagent?.description ?? null,
      session.itemId,
      session.projectId,
      epicOf(item),
      session.stage,
      item?.kind ?? '',
      model,
      budget?.id ?? null,
      event.turn,
      event.contextTokens ?? event.inputTokens + cacheRead + cacheWrite,
      event.inputTokens,
      cacheRead,
      cacheWrite,
      event.outputTokens,
      cost,
      budget && kind ? kind.unit(budget.config) : null,
      event.costUsd ?? null,
      Math.max(0, at - previous),
      dayKey(now),
      weekKey(now),
      monthKey(now),
    );
    if (!event.subagent) drawsFrom.set(session.id, budget?.id ?? null);
    const stored = fromRecordRow(selectRecord.get(result.lastInsertRowid) as unknown as RecordRow);
    bus.publish('usage.recorded', { record: stored, itemId: session.itemId, projectId: session.projectId, sessionId: session.id });
    if (budget) {
      for (const m of measure(budget, { sessionId: session.id, projectId: session.projectId })) {
        if (m.used >= m.cap) reach(budget, m, session.itemId, session.projectId);
      }
    }
    sessions.noteUsage(session.id, sessionUsage(session.id, session.projectId));
    publishBudgets();
  };

  /** The subscription Budget a Session's readings count toward: the one it draws from, else its start model's. */
  const subscriptionOf = (sessionId: string, model: string | undefined) => {
    const budget = budgetById(drawsFrom.get(sessionId)) ?? budgetForModel(model);
    return budget?.kind === 'subscription' ? budget : undefined;
  };
  const subscriptionConfig = (budget: Budget) => budget.config as unknown as SubscriptionBudgetConfig;
  const asSubscription = (budget: Budget): SubscriptionBudget => ({ id: budget.id, name: budget.name, config: subscriptionConfig(budget), models: budget.models });

  const rules = createSubscriptionRules({
    db,
    bus,
    work,
    sessions,
    asks,
    clock,
    quota,
    stageModels: createStageModels(db),
    budgets: () => loadBudgets().filter((b) => b.kind === 'subscription').map(asSubscription),
    drawsFrom: (id) => drawsFrom.get(id),
    poke,
    changed: () => publishBudgets(),
  });

  const recordReading = (event: SessionAgentEvent<'quota_reading'>['payload']) => {
    const session = sessions.session(event.sessionId);
    if (!session) return;
    const budget = subscriptionOf(session.id, session.model);
    const at = { sessionId: session.id, itemId: session.itemId, projectId: session.projectId };
    const { stored, previous } = quota.record(at, event.reading, budget && { id: budget.id, config: subscriptionConfig(budget) });
    bus.publish('quota.recorded', { reading: stored, ...at });
    if (budget) {
      checkSessions(budget);
      rules.afterReading(asSubscription(budget), stored, previous);
    }
    publishBudgets();
  };

  /** Measures the Budget's Session limits for every live Session drawing from it (a reading can move their share). */
  const checkSessions = (budget: Budget) => {
    for (const s of sessions.active()) {
      if (drawsFrom.get(s.id) !== budget.id) continue;
      for (const m of measure(budget, { sessionId: s.id, projectId: s.projectId }, ['session'])) {
        if (m.used >= m.cap) reach(budget, m, s.itemId, s.projectId);
      }
      sessions.noteUsage(s.id, sessionUsage(s.id, s.projectId));
    }
  };

  const unsubscribe = bus.subscribe((event) => {
    if (event.type === 'session.started') {
      const { session } = (event as SessionStartedEvent).payload;
      startedAt.set(session.id, clock.now().getTime());
      const budget = budgetForModel(session.model);
      drawsFrom.set(session.id, budget?.id ?? null);
      if (budget && budgetKind(budget.kind)?.gauge) publishBudgets();
    } else if (event.type === 'session.updated') {
      // A gauge that counts running Sessions (local) changes as they pause, wait, resume or end.
      const { session } = (event as SessionUpdatedEvent).payload;
      const budget = budgetById(drawsFrom.get(session.id));
      if (budget && budgetKind(budget.kind)?.gauge) publishBudgets();
    } else if (event.type === 'session.quota_reading') {
      const payload = (event as SessionAgentEvent<'quota_reading'>).payload;
      // Queued like turns, so a reading's place among the usage records is the order they came in.
      queueMicrotask(() => {
        try {
          recordReading(payload);
        } catch (err) {
          bus.publish('quota.record_failed', { sessionId: payload.sessionId, itemId: payload.itemId, projectId: payload.projectId, error: String(err) });
        }
      });
    } else if (event.type === 'session.usage') {
      const payload = (event as SessionAgentEvent<'usage'>).payload;
      // After the publishing listener loop, so `usage.recorded` follows the turn on every stream.
      queueMicrotask(() => {
        try {
          record(payload);
        } catch (err) {
          bus.publish('usage.record_failed', { sessionId: payload.sessionId, itemId: payload.itemId, projectId: payload.projectId, error: String(err) });
        }
      });
    }
  });

  // A day or month rolling over lifts period start guards: on Kiln's clock moving, and at each local midnight.
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const scheduleMidnight = () => {
    if (midnight) clearTimeout(midnight);
    const now = clock.now();
    midnight = setTimeout(rolledOver, Math.max(1_000, periodEnd('day', now).getTime() - now.getTime() + 1_000));
    midnight.unref();
  };
  const rolledOver = () => {
    rules.tick();
    sweepSessions();
    publishBudgets();
    poke();
    scheduleMidnight();
  };
  /**
   * Time passes between turns: re-measures each running Session's own limits (a wall-time cap is
   * reached with no new turn) and refreshes the warnings on its Item.
   */
  const sweepSessions = () => {
    for (const s of sessions.active()) {
      if (s.state !== 'running') continue;
      const budget = budgetById(drawsFrom.get(s.id));
      if (!budget) continue;
      for (const m of measure(budget, { sessionId: s.id, projectId: s.projectId }, ['session'])) {
        if (m.used >= m.cap) reach(budget, m, s.itemId, s.projectId);
      }
      sessions.noteUsage(s.id, sessionUsage(s.id, s.projectId));
    }
  };
  const sweep = setInterval(sweepSessions, 30_000);
  sweep.unref();
  scheduleMidnight();
  const stopClock = clock.onChange(rolledOver);

  return {
    budgets: list,

    setBudget(id, input) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new WorkError(400, 'A Budget id is lower-case letters, digits, "-" and "_"');
      const body = (input ?? {}) as Record<string, unknown>;
      const { kind: kindId, name, models, ...settings } = body;
      const kind = budgetKind(String(kindId));
      if (!kind) throw new WorkError(400, `"kind" must be a Budget kind Kiln has: ${budgetKindIds().join(', ')}`);
      if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === 'string' && m.trim())) {
        throw new WorkError(400, '"models" must list the models that draw from this Budget');
      }
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new WorkError(400, '"name" must be a name');
      const clash = loadBudgets().find((b) => b.id !== id && b.models.some((m) => models.includes(m)));
      if (clash) {
        const model = clash.models.find((m) => models.includes(m));
        throw new WorkError(409, `The model "${model}" already belongs to the Budget "${clash.name}"; a model draws from one Budget`);
      }
      const config = kind.configure(settings);
      upsertBudget.run(id, kind.id, (name as string | undefined)?.trim() ?? id, JSON.stringify(config), JSON.stringify(models));
      publishBudgets();
      poke();
      return info(budgetById(id)!);
    },

    removeBudget(id) {
      if (!budgetById(id)) throw new WorkError(404, `No Budget "${id}"`);
      deleteBudget.run(id);
      publishBudgets();
      poke();
    },

    records({ session, item }) {
      const where: string[] = [];
      const args: string[] = [];
      if (session) {
        where.push('COALESCE(parent_session_id, session_id) = ?');
        args.push(session);
      }
      if (item) {
        where.push('item_id = ?');
        args.push(item);
      }
      const sql = `SELECT * FROM usage_records${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
      return (db.prepare(sql).all(...args) as unknown as RecordRow[]).map(fromRecordRow);
    },

    rollup(by, { budget, project, item, from, to }) {
      if (!USAGE_GROUPS.includes(by as UsageGroup)) throw new WorkError(400, `"by" is one of ${USAGE_GROUPS.join(', ')}`);
      const column = GROUP_COLUMN[by as UsageGroup];
      const where = [`${column} IS NOT NULL`];
      const args: string[] = [];
      const add = (clause: string, value: string | undefined) => {
        if (value === undefined) return;
        where.push(clause);
        args.push(value);
      };
      add('budget_id = ?', budget);
      add('project_id = ?', project);
      add('item_id = ?', item);
      add('day >= ?', from);
      add('day <= ?', to);
      const rows = db
        .prepare(
          `SELECT ${column} AS key, budget_id AS budgetId, MAX(unit) AS unit, COUNT(*) AS turns,
                  SUM(input_tokens) AS inputTokens, SUM(cache_read_tokens) AS cacheReadTokens,
                  SUM(cache_write_tokens) AS cacheWriteTokens, SUM(output_tokens) AS outputTokens,
                  COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(cost_usd), 0) AS costUsd
           FROM usage_records WHERE ${where.join(' AND ')}
           GROUP BY ${column}, budget_id ORDER BY MIN(id)`,
        )
        .all(...args) as unknown as UsageRollup[];
      return rows.map((r) => ({ ...r }));
    },

    quotaReadings: (filter) => quota.readings(filter),

    quotaRollup(by, { budget: id, window }) {
      const budget = budgetById(id);
      if (!budget || budget.kind !== 'subscription') throw new WorkError(404, `No subscription Budget "${id ?? ''}"`);
      if (!QUOTA_WINDOWS.some((w) => w.id === window)) throw new WorkError(400, `"window" is one of ${QUOTA_WINDOWS.map((w) => w.id).join(', ')}`);
      return quota.rollup(budget.id, subscriptionConfig(budget), window as QuotaWindowId, by);
    },

    startHold({ itemId, projectId, attended }) {
      // No Agent ready: the start itself says so and keeps the Item in Up next.
      const planned = sessions.plannedStart(itemId);
      if (!planned) return undefined;
      const { model } = planned;
      if (!model) return unplanned(itemId, undefined);
      const budget = budgetForModel(model);
      // Until a first Budget is set up (setup not done), usage is recorded without caps.
      if (!budget) return loadBudgets().length ? unplanned(itemId, model) : undefined;
      settleUnplanned(itemId);
      const reached = measure(budget, { projectId }, ['budget', 'project']).find((m) => m.used >= m.cap);
      if (reached) return `${budget.name}: ${reached.spec.name} reached (${fmt(reached.used)} of ${fmt(reached.cap)} ${reached.state.unit})`;
      return budget.kind === 'subscription' ? rules.startHold(asSubscription(budget), { itemId, projectId, ...(model ? { model } : {}), ...(attended ? { attended } : {}) }) : undefined;
    },

    setEnqueue: (enqueue) => rules.setEnqueue(enqueue),

    pools() {
      const out: Record<string, number> = {};
      for (const budget of loadBudgets()) {
        for (const [name, size] of Object.entries(budgetKind(budget.kind)?.pools?.(budget.config) ?? {})) {
          out[name] = Math.min(size, out[name] ?? size);
        }
      }
      return out;
    },

    poolsFor({ itemId }) {
      const budget = budgetForModel(sessions.plannedModel(itemId));
      return budget ? Object.keys(budgetKind(budget.kind)?.pools?.(budget.config) ?? {}) : [];
    },

    doctorCheck: {
      id: 'budgets',
      name: 'Budgets',
      run() {
        const budgets = loadBudgets();
        const loose = (unbudgetedModels.all() as { model: string }[]).map((r) => r.model);
        // A subscription window with no current reading is unknown, and its rules are off (ticket 17).
        const unknown = budgets
          .filter((b) => b.kind === 'subscription')
          .flatMap((b) => quota.windows(b.id, subscriptionConfig(b)).filter((w) => !w.known).map((w) => `${b.name}: ${w.name} is unknown`));
        const warnings = [
          ...(loose.length ? [`Usage from ${loose.join(', ')} draws from no Budget, so no cap covers it.`] : []),
          ...(unknown.length ? [`${unknown.join('; ')}, so its pace and reserve rules are off until the Agent reports a reading.`] : []),
        ];
        if (warnings.length) {
          const fixes = [
            ...(loose.length ? ['Add each model to a Budget (PUT /api/budgets/:id).'] : []),
            ...(unknown.length ? ['Run a Session on the Budget so its Agent reports quota readings; if a window stays unknown, the plan does not report it.'] : []),
          ];
          return { status: 'warn', detail: warnings.join(' '), fix: fixes.join(' ') };
        }
        if (budgets.length === 0) return { status: 'not-configured', detail: 'No Budget is set up yet, so usage is recorded without caps.' };
        return { status: 'pass', detail: budgets.map((b) => `${b.name}: ${info(b).gauge.label}`).join('; ') };
      },
    },

    close() {
      unsubscribe();
      rules.close();
      stopClock();
      if (midnight) clearTimeout(midnight);
      clearInterval(sweep);
    },
  };
}
