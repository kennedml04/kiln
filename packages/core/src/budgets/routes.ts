// Core API routes for Budgets and usage.
//   GET    /api/budgets              BudgetInfo[] (settings, header gauge, held)
//   PUT    /api/budgets/:id          SetBudgetRequest (Admin) -> BudgetInfo; 409 when a model is in another Budget
//   DELETE /api/budgets/:id          (Admin)
//   GET    /api/usage/records        ?session=&item= -> UsageRecord[] (a Session's includes its subagents')
//   GET    /api/usage                ?by=<group>&budget=&project=&item=&from=&to= -> UsageRollup[]
//   GET    /api/quota/readings       ?budget=&session= -> QuotaReadingRecord[] (subscription Budgets)
//   GET    /api/usage/quota          ?budget=&window=5h|week|fable&by=<group> -> QuotaRollup[] (approximate)
//   GET    /api/test/clock          (test instances only) -> {now}
//   POST   /api/test/clock           (test instances only) SetTestClockRequest -> {now}
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SetTestClockRequest } from '@kiln/widget-sdk';
import type { Clock } from '../clock.ts';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { UsageService } from './usage.ts';

const BUDGET = /^\/api\/budgets\/([^/]+)$/;

/** Answers the request if it is a Budget or usage route; returns false otherwise. */
export async function handleBudgetRoute(
  usage: UsageService,
  clock: Clock,
  testMode: boolean,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  try {
    const route = `${req.method} ${url.pathname}`;
    const param = (name: string) => url.searchParams.get(name) ?? undefined;
    if (route === 'GET /api/budgets') return (sendJson(res, 200, usage.budgets()), true);
    const budget = BUDGET.exec(url.pathname);
    if (budget && req.method === 'PUT') return (sendJson(res, 200, usage.setBudget(decodeURIComponent(budget[1]!), await readJson(req))), true);
    if (budget && req.method === 'DELETE') {
      usage.removeBudget(decodeURIComponent(budget[1]!));
      return (sendJson(res, 200, { removed: true }), true);
    }
    if (route === 'GET /api/usage/records') return (sendJson(res, 200, usage.records({ session: param('session'), item: param('item') })), true);
    if (route === 'GET /api/quota/readings') return (sendJson(res, 200, usage.quotaReadings({ budget: param('budget'), session: param('session') })), true);
    if (route === 'GET /api/usage/quota') {
      return (sendJson(res, 200, usage.quotaRollup(param('by') ?? '', { budget: param('budget'), window: param('window') })), true);
    }
    if (route === 'GET /api/usage') {
      const filter = { budget: param('budget'), project: param('project'), item: param('item'), from: param('from'), to: param('to') };
      return (sendJson(res, 200, usage.rollup(param('by') ?? '', filter)), true);
    }
    if (testMode && url.pathname === '/api/test/clock') {
      if (req.method === 'GET') return (sendJson(res, 200, { now: clock.now().toISOString() }), true);
      if (req.method === 'POST') {
        const body = ((await readJson(req)) ?? {}) as SetTestClockRequest;
        try {
          return (sendJson(res, 200, { now: clock.set(body).toISOString() }), true);
        } catch (err) {
          if (err instanceof RangeError) throw new WorkError(400, err.message);
          throw err;
        }
      }
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
