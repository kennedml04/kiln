// Core API routes for Widget panels. The `/api/widget/panels/` routes are the Widget's own (its
// credential); the rest are for the Shell, behind the usual roles (see access.ts).
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { ActionRequest } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import type { WidgetPanels } from './panels.ts';

export interface PanelRouteDeps {
  access: Access;
  /** The Widget holding the request's credential, or a 401. */
  widgetId(req: IncomingMessage): string;
  sendJson(res: ServerResponse, code: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

const WIDGET_PANEL = /^\/api\/widget\/panels\/([^/]+)$/;
const WIDGET_PAGE_MESSAGE = /^\/api\/widget\/panels\/([^/]+)\/messages$/;
const ACTION = /^\/api\/widgets\/([^/]+)\/actions\/([^/]+)$/;
const PAGE_FILE = /^\/api\/widgets\/([^/]+)\/pages\/([^/]+)\/(.+)$/;

/**
 * Every embedded page file is served with this, so even opened on its own it runs in an opaque
 * origin: no Shell cookies, storage or DOM, and no network at all (it talks only through the
 * Shell's message bridge). `allow-same-origin` must never be added.
 */
const PAGE_CSP = "sandbox allow-scripts; connect-src 'none'; form-action 'none'; base-uri 'none'";

const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

/** Answers the panel routes. Returns false when the request is not one of them. */
export async function handlePanelRoute(
  panels: WidgetPanels,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PanelRouteDeps,
): Promise<boolean> {
  const { sendJson, readJson } = deps;
  if (req.method === 'GET' && url.pathname === '/api/panels') {
    sendJson(res, 200, panels.list());
    return true;
  }
  const action = ACTION.exec(url.pathname);
  if (action && req.method === 'POST') {
    const widgetId = decodeURIComponent(action[1]!);
    const name = decodeURIComponent(action[2]!);
    const body = ((await readJson(req)) ?? {}) as ActionRequest;
    deps.access.note(req, { target: `widget:${widgetId}`, detail: { action: name, panelId: body.panelId ?? null } });
    panels.action(widgetId, name, body, deps.access.caller(req).actor);
    sendJson(res, 202, { sent: true });
    return true;
  }
  const page = PAGE_FILE.exec(url.pathname);
  if (page && req.method === 'GET') {
    const file = panels.pageFile(decodeURIComponent(page[1]!), decodeURIComponent(page[2]!), decodeURIComponent(page[3]!));
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': PAGE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-security-policy': PAGE_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  }
  const own = WIDGET_PANEL.exec(url.pathname);
  if (own && req.method === 'PUT') {
    const widgetId = deps.widgetId(req);
    sendJson(res, 200, panels.publish(widgetId, decodeURIComponent(own[1]!), await readJson(req)));
    return true;
  }
  const message = WIDGET_PAGE_MESSAGE.exec(url.pathname);
  if (message && req.method === 'POST') {
    const widgetId = deps.widgetId(req);
    panels.pageMessage(widgetId, decodeURIComponent(message[1]!), await readJson(req));
    sendJson(res, 202, { sent: true });
    return true;
  }
  return false;
}
