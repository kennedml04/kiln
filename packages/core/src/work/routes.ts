// Core API routes for Projects and Items.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateItemRequest, RegisterProjectRequest } from '@kiln/widget-sdk';
import { WorkError, type Work } from './work.ts';

export interface RouteHelpers {
  sendJson(res: ServerResponse, code: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

const PROJECT_ITEMS = /^\/api\/projects\/([^/]+)\/items$/;
const PROJECT = /^\/api\/projects\/([^/]+)$/;
const ITEM = /^\/api\/items\/(.+)$/;

/** Answers the request if it is a Work route; returns false otherwise. */
export async function handleWorkRoute(
  work: Work,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method;
  try {
    if (path === '/api/projects') {
      if (method === 'GET') return (sendJson(res, 200, work.projects()), true);
      if (method === 'POST') {
        return (sendJson(res, 201, await work.register((await readJson(req)) as RegisterProjectRequest)), true);
      }
    }
    if (path === '/api/items' && method === 'GET') {
      return (sendJson(res, 200, work.items(url.searchParams.get('project') ?? undefined)), true);
    }
    let match = PROJECT.exec(path);
    if (match && method === 'GET') {
      const project = work.project(decodeURIComponent(match[1]!));
      if (!project) throw new WorkError(404, `No Project "${match[1]}"`);
      return (sendJson(res, 200, project), true);
    }
    match = PROJECT_ITEMS.exec(path);
    if (match) {
      const projectId = decodeURIComponent(match[1]!);
      if (method === 'GET') return (sendJson(res, 200, work.items(projectId)), true);
      if (method === 'POST') {
        const body = (await readJson(req)) as CreateItemRequest;
        return (sendJson(res, 201, await work.createItem(projectId, body)), true);
      }
    }
    match = ITEM.exec(path);
    if (match && method === 'PATCH') {
      const body = ((await readJson(req)) ?? {}) as { stage?: string };
      work.moveItem(decodeURIComponent(match[1]!), String(body.stage ?? ''));
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
