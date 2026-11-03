// The subscription Budget's window rules (ticket 17), on top of the per-Session caps in usage.ts.
//
//   pace      The week's usage is more than `paceAhead` points ahead of the time gone: new unattended
//             Sessions hold in Up next behind one blocking Ask a week ("Hold until back on pace" /
//             "Start anyway"). Running Sessions carry on, and Thread messages still go through.
//   reserve   A window at `100 - reserve`:
//               5-hour  pauses the Budget's work behind a non-blocking Ask and resumes it by itself
//                       once the window resets (Wait / Stop);
//               week    pauses the Budget's work behind a blocking Continue / Stop Ask;
//               Fable   pauses the Sessions on Fable, one blocking Ask per Stage offering the
//                       Stage's fallback model ("Use <model>" / "Wait for the reset" / "Stop").
//   overage   The plan reports paid overage (or its used credits rose): the Budget's work pauses
//             behind a blocking Continue / Stop Ask.
//
// A window with no current reading is unknown and its rules are off: Kiln never guesses.
// Holds and their Asks live in memory; answers that waive a rule for the week are stored.
import type { DatabaseSync } from 'node:sqlite';
import type { Ask, QuotaReadingRecord, QuotaWindowId, QuotaWindowState, SubscriptionBudgetConfig } from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { Clock } from '../clock.ts';
import type { EventBus } from '../events.ts';
import type { SessionManager } from '../flow/session-manager.ts';
import type { Work } from '../work/work.ts';
import { onFable } from './kinds.ts';
import type { QuotaStore } from './quota.ts';
import type { StageModels } from './stage-models.ts';

export interface SubscriptionBudget {
  id: string;
  name: string;
  config: SubscriptionBudgetConfig;
  models: string[];
}

type Rule = 'reserve' | 'overage' | 'pace';

interface RuleHold {
  key: string;
  budgetId: string;
  rule: Rule;
  window: QuotaWindowId | null;
  /** The week period a waiver from this hold's Ask counts for. */
  period: string;
  askIds: string[];
  sessions: Set<string>;
  /** Fable holds: the Ask for each Stage (`project/kind/stage`) and the Sessions in it. */
  stages?: Map<string, { askId: string; sessions: Set<string>; fallback?: string }>;
}

export interface SubscriptionRulesDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  sessions: SessionManager;
  asks: AskService;
  clock: Clock;
  quota: QuotaStore;
  stageModels: StageModels;
  /** The subscription Budgets now. */
  budgets: () => SubscriptionBudget[];
  /** The Budget a live Session draws from. */
  drawsFrom: (sessionId: string) => string | null | undefined;
  poke: () => void;
  /** Shows the Budget's changed state (holds, gauges) to the Shell. */
  changed: () => void;
}

export interface SubscriptionRules {
  /** Why an Item drawing from this Budget may not start now, or undefined. */
  /** `attended`: a person started it from the Thread, so the pace rule (for unattended Sessions) lets it through. */
  startHold(budget: SubscriptionBudget, entry: { itemId: string; projectId: string; model?: string; attended?: boolean }): string | undefined;
  /** A reading was stored for the Budget. */
  afterReading(budget: SubscriptionBudget, stored: QuotaReadingRecord, previous: QuotaReadingRecord | undefined): void;
  /** Delivers an answer to a rule's Ask; false when the Ask is not one of the rules'. */
  deliver(ask: Ask): boolean;
  /** Whether a rule holds the Budget's work now. */
  held(budgetId: string): boolean;
  /** Kiln's clock moved: windows may have reset. */
  tick(): void;
  /** The scheduler's enqueue, for re-queuing Fable Sessions moved to a fallback (wired once both exist). */
  setEnqueue(enqueue: (itemId: string) => Promise<unknown>): void;
  close(): void;
}

const pct = (n: number | null) => `${Math.round((n ?? 0) * 10) / 10}%`;

export function createSubscriptionRules(deps: SubscriptionRulesDeps): SubscriptionRules {
  const { db, bus, work, sessions, asks, clock, quota, stageModels, budgets, drawsFrom, poke, changed } = deps;
  const selectWaiver = db.prepare('SELECT extra FROM budget_allowances WHERE budget_id = ? AND limit_id = ? AND scope_key = ? AND period = ?');
  const addWaiver = db.prepare(
    `INSERT INTO budget_allowances (budget_id, limit_id, scope_key, period, extra) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (budget_id, limit_id, scope_key, period) DO NOTHING`,
  );
  const waived = (budgetId: string, rule: string, period: string) => !!selectWaiver.get(budgetId, rule, budgetId, period);

  const holds = new Map<string, RuleHold>();
  /** The pace Ask raised for each Budget and week, so it is asked once a week. */
  const paceAsks = new Map<string, string>();
  /** Fable Sessions moved to a fallback model: re-queued once they have stopped. */
  const requeue = new Set<string>();
  let enqueue: ((itemId: string) => Promise<unknown>) | undefined;

  const windowsOf = (budget: SubscriptionBudget) => quota.windows(budget.id, budget.config);
  const windowOf = (budget: SubscriptionBudget, id: QuotaWindowId): QuotaWindowState => windowsOf(budget).find((w) => w.id === id)!;
  /** The week a waiver counts for: the week window's reset time (or "unknown"). */
  const weekPeriod = (budget: SubscriptionBudget) => windowOf(budget, 'week').resetsAt ?? 'unknown';

  const onBudget = (budgetId: string) => sessions.active().filter((s) => drawsFrom(s.id) === budgetId);
  const sessionOnFable = (budget: SubscriptionBudget, sessionId: string) => onFable(budget.config, sessions.session(sessionId)?.model);

  const stageOf = (projectId: string, kind: string, stageId: string) =>
    work.project(projectId)?.workflow.kinds.find((k) => k.id === kind)?.stages.find((s) => s.id === stageId);
  /** The model a Fable Stage falls back to: its own `fallbackModel`, else the Budget's first model not on Fable. */
  const fallbackFor = (budget: SubscriptionBudget, projectId: string, kind: string, stageId: string) =>
    stageOf(projectId, kind, stageId)?.fallbackModel ?? budget.models.find((m) => !onFable(budget.config, m));

  const holdKey = (budgetId: string, rule: Rule, window: QuotaWindowId | null) => [budgetId, rule, window ?? ''].join('\u0000');

  const pause = (hold: RuleHold, ids: string[]) => {
    for (const id of ids) {
      if (hold.sessions.has(id)) continue;
      hold.sessions.add(id);
      sessions.hold(id, hold.key);
    }
  };

  const release = (hold: RuleHold, { answerAs }: { answerAs?: string } = {}) => {
    holds.delete(hold.key);
    for (const id of hold.sessions) sessions.release(id, hold.key);
    if (answerAs) {
      for (const askId of hold.askIds) {
        const ask = asks.get(askId);
        if (ask?.state === 'open') asks.answer(askId, answerAs, { kind: 'kiln' });
      }
    }
    bus.publish('quota.released', { budgetId: hold.budgetId, rule: hold.rule, window: hold.window, released: [...hold.sessions] });
    changed();
    poke();
  };

  const stopAll = (hold: RuleHold) => {
    holds.delete(hold.key);
    for (const id of hold.sessions) sessions.stop(id);
    changed();
    poke();
  };

  const announce = (hold: RuleHold, itemId: string, projectId: string) =>
    bus.publish('quota.hold', {
      budgetId: hold.budgetId,
      rule: hold.rule,
      window: hold.window,
      askIds: hold.askIds,
      paused: [...hold.sessions],
      itemId,
      projectId,
    });

  /** Pauses all the Budget's work behind one Ask (5-hour and week reserve, overage). */
  const holdAll = (budget: SubscriptionBudget, rule: Rule, window: QuotaWindowId | null, at: { itemId: string; projectId: string }, ask: {
    question: string;
    why: string;
    options: string[];
    recommendation: string;
    blocking: boolean;
  }) => {
    const key = holdKey(budget.id, rule, window);
    const existing = holds.get(key);
    if (existing) return pause(existing, onBudget(budget.id).map((s) => s.id));
    const raised = asks.raise({ type: 'decision', ...ask, itemId: at.itemId, raisedBy: { kind: 'budget', budgetId: budget.id } });
    const hold: RuleHold = { key, budgetId: budget.id, rule, window, period: weekPeriod(budget), askIds: [raised.id], sessions: new Set() };
    holds.set(key, hold);
    pause(hold, onBudget(budget.id).map((s) => s.id));
    announce(hold, at.itemId, at.projectId);
    changed();
  };

  /** Pauses the Budget's Sessions on Fable, one Ask per Stage they are in. */
  const holdFable = (budget: SubscriptionBudget, fable: QuotaWindowState, at: { itemId: string; projectId: string }) => {
    const key = holdKey(budget.id, 'reserve', 'fable');
    let hold = holds.get(key);
    const fresh = !hold;
    if (!hold) {
      hold = { key, budgetId: budget.id, rule: 'reserve', window: 'fable', period: weekPeriod(budget), askIds: [], sessions: new Set(), stages: new Map() };
      holds.set(key, hold);
    }
    for (const s of onBudget(budget.id)) {
      if (!sessionOnFable(budget, s.id) || hold.sessions.has(s.id)) continue;
      const item = work.item(s.itemId);
      const stageKey = [s.projectId, item?.kind ?? '', s.stage].join('/');
      let stage = hold.stages!.get(stageKey);
      if (!stage) {
        const fallback = fallbackFor(budget, s.projectId, item?.kind ?? '', s.stage);
        const options = [...(fallback ? [`Use ${fallback}`] : []), 'Wait for the reset', 'Stop'];
        const resets = fable.resetsAt ? ` It resets at ${fable.resetsAt}.` : '';
        const raised = asks.raise({
          type: 'decision',
          question: `${budget.name}: Fable is at ${pct(fable.percent)}, its ${budget.config.reserve}% reserve. Move the ${s.stage} Stage to ${fallback ?? 'another model'}?`,
          why: `Kiln paused this Stage's Sessions on Fable; nothing was stopped.${resets} "Use ${fallback ?? '…'}" restarts them on the fallback model; Wait resumes them after the reset.`,
          recommendation: options[0]!,
          options,
          blocking: true,
          itemId: s.itemId,
          raisedBy: { kind: 'budget', budgetId: budget.id },
        });
        stage = { askId: raised.id, sessions: new Set(), ...(fallback ? { fallback } : {}) };
        hold.stages!.set(stageKey, stage);
        hold.askIds.push(raised.id);
      }
      stage.sessions.add(s.id);
      pause(hold, [s.id]);
    }
    if (fresh) announce(hold, at.itemId, at.projectId);
    changed();
  };

  /** Checks every rule against the Budget's windows: raises new holds, lifts the ones whose window reset. */
  const evaluate = (budget: SubscriptionBudget, at?: { itemId: string; projectId: string }, overage?: boolean) => {
    const windows = windowsOf(budget);
    const win = (id: QuotaWindowId) => windows.find((w) => w.id === id)!;
    const period = weekPeriod(budget);
    const name = budget.name;

    // Lift holds whose window reset or went unknown.
    for (const hold of [...holds.values()]) {
      if (hold.budgetId !== budget.id || hold.rule !== 'reserve' || !hold.window) continue;
      const w = win(hold.window);
      if (!w.known || !w.atReserve) release(hold, { answerAs: hold.window === 'fable' ? 'Wait for the reset' : hold.window === '5h' ? 'Wait' : 'Continue' });
    }
    if (!at) return;

    const fiveHour = win('5h');
    if (fiveHour.known && fiveHour.atReserve) {
      holdAll(budget, 'reserve', '5h', at, {
        question: `${name}: the 5-hour window is at ${pct(fiveHour.percent)}, its ${budget.config.reserve}% reserve. Kiln paused ${name} work until it resets.`,
        why: `Nothing was stopped. Kiln resumes the paused Sessions by itself when the window resets${fiveHour.resetsAt ? ` (${fiveHour.resetsAt})` : ''}; Stop ends them.`,
        options: ['Wait', 'Stop'],
        recommendation: 'Wait',
        blocking: false,
      });
    }
    const weekly = win('week');
    if (weekly.known && weekly.atReserve && !waived(budget.id, 'week-reserve', period)) {
      holdAll(budget, 'reserve', 'week', at, {
        question: `${name}: the week is at ${pct(weekly.percent)}, its ${budget.config.reserve}% reserve. Continue all ${name} work?`,
        why: 'Kiln paused all the Budget\'s work; nothing was stopped. Continue lets it run into the reserve this week; Stop ends the paused Sessions.',
        options: ['Continue', 'Stop'],
        recommendation: 'Stop',
        blocking: true,
      });
    }
    const fable = win('fable');
    if (fable.known && fable.atReserve) holdFable(budget, fable, at);
    if (overage && !waived(budget.id, 'overage', period)) {
      holdAll(budget, 'overage', null, at, {
        question: `${name}: the plan is now drawing paid overage. Continue ${name} work?`,
        why: 'Kiln paused all the Budget\'s work; nothing was stopped. Continue allows overage for the rest of this week; Stop ends the paused Sessions.',
        options: ['Continue', 'Stop'],
        recommendation: 'Stop',
        blocking: true,
      });
    }
  };

  // A window's reset lifts its hold even while Kiln's clock stands still: a timer at the next reset.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const now = clock.now().getTime();
    const resets = budgets()
      .flatMap((b) => windowsOf(b))
      .map((w) => (w.known && w.resetsAt ? Date.parse(w.resetsAt) : NaN))
      .filter((t) => t > now);
    if (!resets.length) return;
    timer = setTimeout(tick, Math.min(2_147_000_000, Math.min(...resets) - now + 1_000));
    timer.unref();
  };
  const tick = () => {
    for (const budget of budgets()) evaluate(budget);
    schedule();
  };

  const pace = (budget: SubscriptionBudget) => {
    const week = windowOf(budget, 'week');
    return week.known && week.aheadOfPace ? week : undefined;
  };

  // Fable Sessions moved to a fallback re-queue once they have stopped.
  const unsubscribe = bus.subscribe((event) => {
    if (event.type !== 'session.updated') return;
    const { session } = (event as { payload: { session: { id: string; itemId: string; state: string } } }).payload;
    if (!requeue.has(session.id) || ['running', 'paused', 'waiting'].includes(session.state)) return;
    requeue.delete(session.id);
    void enqueue?.(session.itemId).catch((err: unknown) =>
      bus.publish('scheduler.start_failed', { itemId: session.itemId, projectId: work.item(session.itemId)?.projectId, error: String(err) }),
    );
  });

  return {
    startHold(budget, { itemId, projectId, model, attended }) {
      for (const hold of holds.values()) {
        if (hold.budgetId !== budget.id) continue;
        if (hold.window === 'fable' && !onFable(budget.config, model)) continue;
        const what = hold.rule === 'overage' ? 'paid overage' : `the ${hold.window === '5h' ? '5-hour window' : hold.window === 'fable' ? 'Fable window' : 'week'} is at its reserve`;
        return `${budget.name}: ${what}`;
      }
      const ahead = !attended && pace(budget);
      if (!ahead) return undefined;
      const period = ahead.resetsAt ?? 'unknown';
      if (waived(budget.id, 'pace', period)) return undefined;
      const paceKey = `${budget.id}\u0000${period}`;
      if (!paceAsks.has(paceKey)) {
        paceAsks.set(paceKey, '');
        // Raised after the guard returns: the scheduler asks its guards while it builds its state.
        queueMicrotask(() => {
          const ask = asks.raise({
            type: 'decision',
            question: `${budget.name}: the week is ahead of pace (${pct(ahead.percent)} used, ${pct(ahead.pace ?? 0)} of the week gone). Hold new unattended Sessions?`,
            why: `Running Sessions carry on. Held Items start by themselves once the week is back within ${budget.config.paceAhead} points of pace; Start anyway lets them start this week.`,
            recommendation: 'Hold until back on pace',
            options: ['Hold until back on pace', 'Start anyway'],
            blocking: true,
            itemId,
            raisedBy: { kind: 'budget', budgetId: budget.id },
          });
          paceAsks.set(paceKey, ask.id);
          bus.publish('quota.hold', { budgetId: budget.id, rule: 'pace', window: 'week', askIds: [ask.id], paused: [], itemId, projectId });
          changed();
        });
      }
      return `${budget.name}: the week is ahead of pace (${pct(ahead.percent)} used, pace ${pct(ahead.pace ?? 0)})`;
    },

    afterReading(budget, stored, previous) {
      const rose = stored.usedCredits !== null && previous?.usedCredits != null && stored.usedCredits > previous.usedCredits;
      const overage = stored.usingOverage || rose;
      evaluate(budget, { itemId: stored.itemId, projectId: stored.projectId }, overage);
      schedule();
    },

    deliver(ask) {
      for (const [key, askId] of paceAsks) {
        if (askId !== ask.id) continue;
        const [budgetId, period] = key.split('\u0000') as [string, string];
        if (ask.answer === 'Start anyway') addWaiver.run(budgetId, 'pace', budgetId, period);
        changed();
        poke();
        return true;
      }
      const hold = [...holds.values()].find((h) => h.askIds.includes(ask.id));
      if (!hold) return false;
      if (hold.window === 'fable') {
        const entry = [...hold.stages!].find(([, s]) => s.askId === ask.id);
        if (!entry) return true;
        const [stageKey, stage] = entry;
        if (ask.answer === 'Wait for the reset') return true;
        hold.stages!.delete(stageKey);
        hold.askIds = hold.askIds.filter((id) => id !== ask.id);
        for (const id of stage.sessions) hold.sessions.delete(id);
        if (ask.answer === 'Stop') {
          for (const id of stage.sessions) sessions.stop(id);
        } else if (stage.fallback && ask.answer === `Use ${stage.fallback}`) {
          const [projectId, kind, stageId] = stageKey.split('/') as [string, string, string];
          stageModels.set(projectId, kind, stageId, stage.fallback);
          for (const id of stage.sessions) {
            requeue.add(id);
            sessions.stop(id);
          }
        }
        if (!hold.stages!.size) holds.delete(hold.key);
        changed();
        poke();
        return true;
      }
      if (ask.answer === 'Stop') return (stopAll(hold), true);
      if (hold.window === '5h') return true; // Wait: resumes by itself at the reset.
      addWaiver.run(hold.budgetId, hold.rule === 'overage' ? 'overage' : 'week-reserve', hold.budgetId, hold.period);
      release(hold);
      return true;
    },

    held(budgetId) {
      if ([...holds.values()].some((h) => h.budgetId === budgetId)) return true;
      const budget = budgets().find((b) => b.id === budgetId);
      const ahead = budget && pace(budget);
      return !!ahead && !waived(budgetId, 'pace', ahead.resetsAt ?? 'unknown');
    },

    tick,

    setEnqueue(fn) {
      enqueue = fn;
    },

    close() {
      unsubscribe();
      if (timer) clearTimeout(timer);
    },
  };
}
