// Core API routes for the scheduler.
//   GET  /api/scheduler                 SchedulerState (pools, the Up next queue in start order, paused)
//   PUT  /api/scheduler/pools/:name     {size} (Admin) -> SchedulerState
//   PUT  /api/scheduler/story-limits/:projectId  {limit} (Admin) -> SchedulerState
//   PUT  /api/scheduler/queue           {order: storyId[], projectId?} sets the Story order (Ticket ids map to their Story) -> SchedulerState
//   POST /api/scheduler/stop-all        pauses every running Session and dispatch -> SchedulerState
//   POST /api/scheduler/resume          continues them and dispatch -> SchedulerState
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReorderQueueRequest, SetPoolSizeRequest, SetStoryLimitRequest } from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { Scheduler } from './scheduler.ts';

const STORY_LIMIT = /^\/api\/scheduler\/story-limits\/([^/]+)$/;
const POOL =/^\/api\/scheduler\/pools\/([^/]+)$/;

/** Answers the request if it is a scheduler route; returns false otherwise. */
export async function handleSchedulerRoute(
  scheduler: Scheduler,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/scheduler')) return false;
  try {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/scheduler') return (sendJson(res, 200, scheduler.state()), true);
    if (route === 'POST /api/scheduler/stop-all') return (sendJson(res, 200, await scheduler.stopAll()), true);
    if (route === 'POST /api/scheduler/resume') return (sendJson(res, 200, await scheduler.resume()), true);
    if (route === 'PUT /api/scheduler/queue') {
      const body = ((await readJson(req)) ?? {}) as Partial<ReorderQueueRequest>;
      return (sendJson(res, 200, await scheduler.reorder(body.order as string[], body.projectId)), true);
    }
    const storyLimit = STORY_LIMIT.exec(url.pathname);
    if (storyLimit && req.method === 'PUT') {
      const body = ((await readJson(req)) ?? {}) as Partial<SetStoryLimitRequest>;
      const value = typeof body.limit === 'number' ? body.limit : Number.NaN;
      return (sendJson(res, 200, await scheduler.setStoryLimit(decodeURIComponent(storyLimit[1]!), value)), true);
    }
    const pool = POOL.exec(url.pathname);
    if (pool && req.method === 'PUT') {
      const body = ((await readJson(req)) ?? {}) as Partial<SetPoolSizeRequest>;
      return (sendJson(res, 200, await scheduler.setPoolSize(decodeURIComponent(pool[1]!), Number(body.size))), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
