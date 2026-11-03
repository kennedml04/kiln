// Calendar periods in the core's local time: a day is `YYYY-MM-DD`, a week is its Monday's day,
// a month is `YYYY-MM`.
import type { LimitPeriod } from './kinds.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const weekKey = (d: Date) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)));

export const periodKey = (period: LimitPeriod, d: Date) => (period === 'day' ? dayKey(d) : monthKey(d));

/** When the period containing `d` ends (the next one's first moment). */
export const periodEnd = (period: LimitPeriod, d: Date) =>
  period === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
