// Core API routes for Widget installs and the Org Policy's Widget sources.
// Access rules for them live in access.ts (reads need Viewer, changes need Admin).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InstallWidgetRequest, UpdateWidgetRequest, WidgetSourcePolicy } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import type { WidgetLifecycle } from './lifecycle.ts';

export interface WidgetRouteDeps {
  access: Access;
  sendJson(res: ServerResponse, code: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

const WIDGET = /^\/api\/widgets\/([^/]+)$/;
const WIDGET_ACTION =/^\/api\/widgets\/([^/]+)\/(approve|start|stop|update)$/;

/** Answers the Widget admin routes. Returns false when the request is not one of them. */
export async function handleWidgetRoute(
  lifecycle: WidgetLifecycle,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WidgetRouteDeps,
): Promise<boolean> {
  const { sendJson, readJson } = deps;
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/org-policy/widget-sources') {
    sendJson(res, 200, lifecycle.sourcePolicy());
    return true;
  }
  if (route === 'PUT /api/org-policy/widget-sources') {
    const policy = lifecycle.setSourcePolicy(((await readJson(req)) ?? {}) as WidgetSourcePolicy);
    deps.access.note(req, { detail: policy });
    sendJson(res, 200, policy);
    return true;
  }
  if (route === 'GET /api/widgets') {
    sendJson(res, 200, lifecycle.list());
    return true;
  }
  if (route === 'POST /api/widgets') {
    const body = ((await readJson(req)) ?? {}) as InstallWidgetRequest;
    deps.access.note(req, { detail: { source: body.source, ref: body.ref, path: body.path } });
    const widget = await lifecycle.install(body);
    deps.access.note(req, { target: `widget:${widget.id}` });
    sendJson(res, 201, widget);
    return true;
  }
  const one = WIDGET.exec(url.pathname);
  if (one && req.method === 'DELETE') {
    const id = decodeURIComponent(one[1]!);
    deps.access.note(req, { target: `widget:${id}` });
    await lifecycle.remove(id);
    sendJson(res, 200, { removed: id });
    return true;
  }
  const action = WIDGET_ACTION.exec(url.pathname);
  if (action && req.method === 'POST') {
    const id = decodeURIComponent(action[1]!);
    deps.access.note(req, { target: `widget:${id}` });
    switch (action[2]) {
      case 'approve': {
        const { actor } = deps.access.caller(req);
        sendJson(res, 200, await lifecycle.approve(id, actor.kind === 'kiln' ? 'kiln' : actor.id));
        return true;
      }
      case 'update': {
        const body = ((await readJson(req)) ?? {}) as UpdateWidgetRequest;
        const widget = await lifecycle.update(id, body);
        deps.access.note(req, { detail: { ref: body.ref, version: widget.version, pending: widget.pendingUpdate?.newNeeds ?? null } });
        sendJson(res, 200, widget);
        return true;
      }
      case 'start':
        sendJson(res, 200, lifecycle.start(id));
        return true;
      case 'stop':
        sendJson(res, 200, await lifecycle.stop(id));
        return true;
    }
  }
  return false;
}
