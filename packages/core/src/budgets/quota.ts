// Quota readings for subscription Budgets: stored as the Agent reported them, classified into the
// Budget's windows (5-hour, week, Fable), and attributed to Sessions.
//
// Attribution: between two readings of a window, the change is what the plan measured. It is split
// across the turns recorded on the Budget between them (for Fable, only turns on Fable), in
// proportion to their tokens. Readings are account-wide, so a share is approximate; a change with
// no Kiln turns in it was someone's own use and is attributed to nobody. Kiln never estimates: a
// window with no current reading is unknown.
import type { DatabaseSync } from 'node:sqlite';
import {
  QUOTA_WINDOWS,
  USAGE_GROUPS,
  type QuotaReading,
  type QuotaReadingRecord,
  type QuotaRollup,
  type QuotaWindowId,
  type QuotaWindowState,
  type SubscriptionBudgetConfig,
  type UsageGroup,
} from '@kiln/widget-sdk';
import type { Clock } from '../clock.ts';
import { WorkError } from '../work/work.ts';
import { onFable } from './kinds.ts';

const WEEK_MS = 7 * 24 * 3_600_000;

interface ReadingRow {
  id: number;
  at: string;
  budget_id: string | null;
  session_id: string;
  item_id: string;
  project_id: string;
  window: string;
  model: string | null;
  window_id: QuotaWindowId | null;
  percent: number | null;
  resets_at: string | null;
  taken_at: string;
  source: string;
  using_overage: number;
  used_credits: number | null;
  after_record: number;
}

interface TurnRow {
  id: number;
  session: string;
  item_id: string;
  epic_id: string | null;
  project_id: string;
  stage: string;
  item_kind: string;
  model: string | null;
  tokens: number;
}

const fromRow = (r: ReadingRow): QuotaReadingRecord => ({
  id: r.id,
  at: r.at,
  budgetId: r.budget_id,
  sessionId: r.session_id,
  itemId: r.item_id,
  projectId: r.project_id,
  window: r.window,
  model: r.model,
  windowId: r.window_id,
  percent: r.percent,
  resetsAt: r.resets_at,
  takenAt: r.taken_at,
  source: r.source,
  usingOverage: r.using_overage === 1,
  usedCredits: r.used_credits,
});

const FIVE_HOUR = new Set(['5h', 'five_hour', 'session']);
const WEEK = new Set(['week', 'weekly', 'seven_day', 'weekly_all']);

/** The window a reading counts toward: a model-scoped reading is Fable's when it carries Fable's label. */
export function classify(reading: Pick<QuotaReading, 'window' | 'model'>, config: SubscriptionBudgetConfig): QuotaWindowId | null {
  if (reading.model) return reading.model.toLowerCase() === config.fableLabel.toLowerCase() ? 'fable' : null;
  if (FIVE_HOUR.has(reading.window)) return '5h';
  if (WEEK.has(reading.window)) return 'week';
  return null;
}

const ROLLUP_KEY: Record<Exclude<UsageGroup, 'day' | 'week' | 'month'>, (t: TurnRow) => string | null> = {
  session: (t) => t.session,
  item: (t) => t.item_id,
  epic: (t) => t.epic_id,
  project: (t) => t.project_id,
  stage: (t) => t.stage,
  kind: (t) => t.item_kind,
};

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** "2d 3h", "4h 10m", "12m". */
export function untilText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1_440);
  const h = Math.floor((minutes % 1_440) / 60);
  const m = minutes % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface QuotaStore {
  /** Stores a reading for the Budget it counts toward (none: stored, counted toward nothing). */
  record(
    at: { sessionId: string; itemId: string; projectId: string },
    reading: QuotaReading,
    budget: { id: string; config: SubscriptionBudgetConfig } | undefined,
  ): { stored: QuotaReadingRecord; previous: QuotaReadingRecord | undefined };
  readings(filter: { budget?: string; session?: string }): QuotaReadingRecord[];
  /** Each key's attributed share of a window's changes. */
  rollup(budgetId: string, config: SubscriptionBudgetConfig, window: QuotaWindowId, by: string): QuotaRollup[];
  /** A Session's attributed share of a window (subagents included), in percent points. */
  sessionShare(budgetId: string, config: SubscriptionBudgetConfig, window: QuotaWindowId, sessionId: string): number;
  /** The Budget's windows now: the latest reading of each, unknown when there is none or it has reset. */
  windows(budgetId: string, config: SubscriptionBudgetConfig): QuotaWindowState[];
}

export function createQuotaStore(db: DatabaseSync, clock: Clock): QuotaStore {
  const insert = db.prepare(
    `INSERT INTO quota_readings (at, budget_id, session_id, item_id, project_id, window, model, window_id, percent, resets_at,
       taken_at, source, using_overage, used_credits, after_record)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM usage_records))`,
  );
  const selectOne = db.prepare('SELECT * FROM quota_readings WHERE id = ?');
  const previousCredits = db.prepare(
    'SELECT * FROM quota_readings WHERE budget_id IS ? AND used_credits IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1',
  );
  const windowReadings = db.prepare(
    'SELECT * FROM quota_readings WHERE budget_id = ? AND window_id = ? AND percent IS NOT NULL ORDER BY id',
  );
  const latest = db.prepare('SELECT * FROM quota_readings WHERE budget_id = ? AND window_id = ? ORDER BY id DESC LIMIT 1');
  const turnsBetween = db.prepare(
    `SELECT id, COALESCE(parent_session_id, session_id) AS session, item_id, epic_id, project_id, stage, item_kind, model,
            input_tokens + output_tokens + cache_read_tokens + cache_write_tokens AS tokens
     FROM usage_records WHERE budget_id = ? AND id > ? AND id <= ? ORDER BY id`,
  );

  /** Every turn's attributed share of the window's measured changes. */
  const attribute = (budgetId: string, config: SubscriptionBudgetConfig, window: QuotaWindowId) => {
    const shares: { turn: TurnRow; percent: number }[] = [];
    const readings = windowReadings.all(budgetId, window) as unknown as ReadingRow[];
    for (let i = 1; i < readings.length; i++) {
      const before = readings[i - 1]!;
      const after = readings[i]!;
      // After a reset the window started again from zero, so the new reading is all new use.
      const reset = after.resets_at !== before.resets_at && Date.parse(after.resets_at ?? '') > Date.parse(before.resets_at ?? '');
      const change = reset ? after.percent! : after.percent! - before.percent!;
      if (change <= 0) continue;
      const turns = (turnsBetween.all(budgetId, before.after_record, after.after_record) as unknown as TurnRow[]).filter(
        (t) => window !== 'fable' || onFable(config, t.model),
      );
      const tokens = turns.reduce((sum, t) => sum + t.tokens, 0);
      if (tokens <= 0) continue;
      for (const turn of turns) shares.push({ turn, percent: (change * turn.tokens) / tokens });
    }
    return shares;
  };

  return {
    record(at, reading, budget) {
      const windowId = budget ? classify(reading, budget.config) : null;
      const result = insert.run(
        clock.now().toISOString(),
        budget?.id ?? null,
        at.sessionId,
        at.itemId,
        at.projectId,
        reading.window,
        reading.model ?? null,
        windowId,
        typeof reading.percent === 'number' ? reading.percent : null,
        reading.resetsAt ?? null,
        reading.takenAt ?? clock.now().toISOString(),
        reading.source ?? 'unknown',
        reading.usingOverage ? 1 : 0,
        typeof reading.usedCredits === 'number' ? reading.usedCredits : null,
      );
      const stored = fromRow(selectOne.get(result.lastInsertRowid) as unknown as ReadingRow);
      const prev = stored.usedCredits === null ? undefined : (previousCredits.get(stored.budgetId, stored.id) as unknown as ReadingRow | undefined);
      return { stored, previous: prev ? fromRow(prev) : undefined };
    },

    readings({ budget, session }) {
      const where: string[] = [];
      const args: string[] = [];
      if (budget) {
        where.push('budget_id = ?');
        args.push(budget);
      }
      if (session) {
        where.push('session_id = ?');
        args.push(session);
      }
      const sql = `SELECT * FROM quota_readings${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
      return (db.prepare(sql).all(...args) as unknown as ReadingRow[]).map(fromRow);
    },

    rollup(budgetId, config, window, by) {
      const keyOf = ROLLUP_KEY[by as keyof typeof ROLLUP_KEY];
      if (!keyOf) throw new WorkError(400, `"by" is one of ${USAGE_GROUPS.filter((g) => g in ROLLUP_KEY).join(', ')}`);
      const totals = new Map<string, number>();
      for (const { turn, percent } of attribute(budgetId, config, window)) {
        const key = keyOf(turn);
        if (key !== null) totals.set(key, (totals.get(key) ?? 0) + percent);
      }
      return [...totals].map(([key, percent]) => ({ key, window, percent: round(percent), approximate: true as const }));
    },

    sessionShare(budgetId, config, window, sessionId) {
      const shares = attribute(budgetId, config, window).filter((s) => s.turn.session === sessionId);
      return round(shares.reduce((sum, s) => sum + s.percent, 0));
    },

    windows(budgetId, config) {
      const now = clock.now().getTime();
      const reserveAt = 100 - config.reserve;
      return QUOTA_WINDOWS.map(({ id, name }): QuotaWindowState => {
        const row = latest.get(budgetId, id) as unknown as ReadingRow | undefined;
        const resetsAt = row?.resets_at ?? null;
        const expired = resetsAt !== null && now >= Date.parse(resetsAt);
        const known = !!row && row.percent !== null && !expired;
        if (!known) {
          const why = expired ? ` (reset ${untilText(now - Date.parse(resetsAt!))} ago; waiting for a reading)` : '';
          return { id, name, known, percent: null, resetsAt: expired ? null : resetsAt, takenAt: row?.taken_at ?? null, reserveAt, atReserve: false, label: `${name}: unknown${why}` };
        }
        const percent = row.percent!;
        const state: QuotaWindowState = {
          id,
          name,
          known,
          percent,
          resetsAt,
          takenAt: row.taken_at,
          reserveAt,
          atReserve: percent >= reserveAt,
          label: '',
        };
        const resets = resetsAt ? `, resets in ${untilText(Date.parse(resetsAt) - now)}` : '';
        let paceText = '';
        if (id === 'week' && resetsAt) {
          const elapsed = Math.min(100, Math.max(0, ((now - (Date.parse(resetsAt) - WEEK_MS)) / WEEK_MS) * 100));
          state.pace = round(elapsed);
          state.aheadOfPace = percent - elapsed > config.paceAhead;
          paceText = `, pace ${Math.round(elapsed)}%`;
        }
        state.label = `${name}: ${round(percent)}% used${paceText}${resets}`;
        return state;
      });
    },
  };
}
