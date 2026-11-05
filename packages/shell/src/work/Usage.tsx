// Usage as Kiln measured it: the header's Budget gauges, a subscription Budget's page, and a
// running Session's live usage. Only reported numbers are shown; Kiln never shows an estimate
// (a subscription's attributed shares are measured changes split by tokens, labelled approximate).
import { useEffect, useState } from 'react';
import type { BudgetInfo, QuotaRollup, QuotaWindowId, SessionUsage, UsageAlert } from '@kiln/widget-sdk';
import { api } from '../api.ts';
import { followLink } from '../router.ts';
import { useStore } from '../store.ts';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export const BUDGET_ROUTE = /^\/budgets\/([^/]+)\/?$/;
const budgetPath = (id: string) => `/budgets/${encodeURIComponent(id)}`;

/**
 * The windows to show: all of them, except the 5-hour window while it has no reading. Max plans no
 * longer have one, and a gauge that is always "unknown" only clutters the header.
 */
const shownWindows = (budget: BudgetInfo) => budget.windows!.filter((w) => w.id !== '5h' || w.known);

/** A subscription Budget's windows: one meter each (week with its pace, 5-hour, Fable), unknown ones said so. */
function WindowGauges({ budget }: { budget: BudgetInfo }) {
  return (
    <span className={`budget-gauge${budget.held ? ' held' : ''}`}>
      <a href={budgetPath(budget.id)} onClick={followLink}>
        {budget.name}
      </a>
      {shownWindows(budget).map((w) => (
        <span key={w.id} className={`budget-window${w.known ? '' : ' unknown'}${w.atReserve || w.aheadOfPace ? ' warn' : ''}`}>
          <meter
            aria-label={`${budget.name} ${w.name}`}
            min={0}
            max={100}
            value={w.percent ?? 0}
            low={50}
            high={w.reserveAt}
            optimum={0}
          />
          <span>{w.label}</span>
        </span>
      ))}
      {budget.held ? <span> (held)</span> : null}
    </span>
  );
}

/** One meter per Budget with a period limit, e.g. "Work: 1,234 of 10,000 credits this month". */
export function BudgetGauges() {
  const budgets = useStore((s) => s.budgets);
  if (budgets.length === 0) return null;
  return (
    <div className="budget-gauges">
      {budgets.map((b) => b.windows ? <WindowGauges key={b.id} budget={b} /> : (
        <span key={b.id} className={`budget-gauge${b.held ? ' held' : ''}`}>
          <meter
            aria-label={`${b.name} budget`}
            min={0}
            max={b.gauge.cap || 1}
            value={b.gauge.used}
            low={b.gauge.cap / 2}
            high={b.gauge.cap * 0.9}
            optimum={0}
          />
          <span>
            {b.name}: {b.gauge.label}
            {b.held ? ' (limit reached)' : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

const GROUPS = [
  { by: 'project', name: 'By Project' },
  { by: 'stage', name: 'By Stage' },
  { by: 'kind', name: 'By Item kind' },
] as const;

function WindowUse({ budgetId, window, title }: { budgetId: string; window: QuotaWindowId; title: string }) {
  const projects = useStore((s) => s.projects);
  const [rollups, setRollups] = useState<Record<string, QuotaRollup[]>>();
  const [error, setError] = useState<string>();
  const budgets = useStore((s) => s.budgets);
  useEffect(() => {
    let current = true;
    Promise.all(GROUPS.map((g) => api<QuotaRollup[]>('GET', `/api/usage/quota?budget=${encodeURIComponent(budgetId)}&window=${window}&by=${g.by}`)))
      .then((lists) => current && (setRollups(Object.fromEntries(GROUPS.map((g, i) => [g.by, lists[i]!]))), setError(undefined)))
      .catch((err: Error) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [budgetId, window, budgets]);
  const label = (by: string, key: string) => (by === 'project' ? (projects[key]?.name ?? key) : key);
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      <p>Each share is the window's measured change split by tokens across the turns in it: approximate.</p>
      {error ? <p role="alert">{error}</p> : null}
      {rollups &&
        GROUPS.map((g) => (
          <table key={g.by} aria-label={g.name}>
            <caption>{g.name}</caption>
            <tbody>
              {rollups[g.by]!.length === 0 ? (
                <tr>
                  <td>No measured use yet</td>
                </tr>
              ) : (
                rollups[g.by]!.map((r) => (
                  <tr key={r.key}>
                    <td>{label(g.by, r.key)}</td>
                    <td>{fmt(r.percent)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        ))}
    </section>
  );
}

/** A subscription Budget's page: its windows and where the week's and Fable's use went. */
export function BudgetPage({ budgetId }: { budgetId: string }) {
  const budget = useStore((s) => s.budgets.find((b) => b.id === budgetId));
  if (!budget) return <p>No Budget "{budgetId}".</p>;
  return (
    <section className="budget-page">
      <h2>{budget.name}</h2>
      {budget.windows ? (
        <>
          <ul>
            {shownWindows(budget).map((w) => (
              <li key={w.id}>{w.label}</li>
            ))}
          </ul>
          <WindowUse budgetId={budget.id} window="week" title="Week use" />
          <WindowUse budgetId={budget.id} window="fable" title="Fable use" />
        </>
      ) : (
        <p>{budget.gauge.label}</p>
      )}
    </section>
  );
}

const alertText = (a: UsageAlert) =>
  `${a.name} ${a.level === 'reached' ? 'reached' : 'at half'}: ${fmt(a.used)} of ${fmt(a.cap)} ${a.unit}`;

/** A Session's live usage on its Item: cost in the Budget's unit, turns, tokens, context, and cap warnings. */
export function UsagePanel({ usage }: { usage: SessionUsage }) {
  return (
    <section aria-label="Usage" className="usage">
      <h3>Usage</h3>
      <dl>
        <dt>Cost</dt>
        <dd>{usage.unit ? `${fmt(usage.cost)} ${usage.unit}` : 'No Budget covers this model'}</dd>
        <dt>Turns</dt>
        <dd>{fmt(usage.turns)}</dd>
        <dt>Tokens</dt>
        <dd>{fmt(usage.tokens)}</dd>
        <dt>Context</dt>
        <dd>{fmt(usage.contextTokens)} tokens</dd>
      </dl>
      {usage.alerts.map((a) => (
        <p key={`${a.budgetId}/${a.id}`} role={a.level === 'reached' ? 'alert' : 'status'} className={`usage-${a.level}`}>
          {alertText(a)}
        </p>
      ))}
    </section>
  );
}

/** The short line on a card. */
export function UsageLine({ usage }: { usage: SessionUsage }) {
  const warned = usage.alerts.length > 0;
  return (
    <span className={`usage-line${warned ? ' usage-warned' : ''}`}>
      {usage.unit ? `${fmt(usage.cost)} ${usage.unit}` : `${fmt(usage.tokens)} tokens`}
      {warned ? ' (cap warning)' : ''}
    </span>
  );
}
