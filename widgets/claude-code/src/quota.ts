// Max plan quota readings, normalised to Kiln's QuotaReading (percent 0-100, ISO times), from the
// two sources docs/research/claude-code-quota-readings.md found: the SDK's experimental usage
// method (the main one; it alone has the per-model weekly window) and `rate_limit_event`s (the
// fallback for the 5-hour and weekly windows).
import type { QuotaReading } from '@kiln/widget-sdk';

interface Window {
  utilization?: number | null;
  resets_at?: string | null;
}

interface LimitRow {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

export interface UsageReply {
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: Window | null;
    seven_day?: Window | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
    extra_usage?: { used_credits?: number | null } | null;
  };
  limits?: LimitRow[];
}

const percentOf = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const iso = (value: string | null | undefined) => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

/**
 * The readings in one usage reply. `limits[]` rows are classified on `kind`, never on a label;
 * the typed `rate_limits` fields fill in windows the rows leave out. Empty when the login has no
 * plan limits (an API key, say).
 */
export function readingsFromUsage(reply: UsageReply, takenAt: string, usingOverage: boolean): QuotaReading[] {
  if (reply.rate_limits_available === false) return [];
  const readings = new Map<string, QuotaReading>();
  const add = (window: string, model: string | null, percent: number | null, resetsAt: string | null) => {
    const key = `${window}|${model ?? ''}`;
    if (readings.has(key)) return;
    readings.set(key, { window, model, percent, resetsAt, takenAt, source: 'get_usage', usingOverage });
  };
  for (const row of reply.limits ?? []) {
    if (row.kind === 'session') add('5h', null, percentOf(row.percent), iso(row.resets_at));
    else if (row.kind === 'weekly_all') add('week', null, percentOf(row.percent), iso(row.resets_at));
    else if (row.kind === 'weekly_scoped' && row.scope?.model?.display_name) {
      add('week', row.scope.model.display_name, percentOf(row.percent), iso(row.resets_at));
    }
  }
  const limits = reply.rate_limits;
  if (limits?.five_hour) add('5h', null, percentOf(limits.five_hour.utilization), iso(limits.five_hour.resets_at));
  if (limits?.seven_day) add('week', null, percentOf(limits.seven_day.utilization), iso(limits.seven_day.resets_at));
  for (const scoped of limits?.model_scoped ?? []) add('week', scoped.display_name, percentOf(scoped.utilization), iso(scoped.resets_at));
  return [...readings.values()];
}

/** Credits spent past the plan so far, if the reply says. */
export const overageCredits = (reply: UsageReply): number | null => percentOf(reply.rate_limits?.extra_usage?.used_credits);

const RATE_LIMIT_WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: 'week' };

/** A `rate_limit_event`'s reading (its utilization is 0-1 and its reset time epoch seconds), if it is for a window Kiln tracks. */
export function readingFromRateLimit(info: Record<string, unknown>, takenAt: string): QuotaReading | null {
  const window = RATE_LIMIT_WINDOWS[String(info.rateLimitType)];
  if (!window) return null;
  const utilization = percentOf(info.utilization as number | undefined);
  const resetsAt = percentOf(info.resetsAt as number | undefined);
  return {
    window,
    model: null,
    percent: utilization === null ? null : Math.round(utilization * 1000) / 10,
    resetsAt: resetsAt === null ? null : new Date(resetsAt * 1000).toISOString(),
    takenAt,
    source: 'rate_limit_event',
    usingOverage: info.isUsingOverage === true,
  };
}
