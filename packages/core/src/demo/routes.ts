// The demo routes (demo-project Ticket 05). Both are Admin work (see access.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DemoError, type Demo } from './demo.ts';

interface RouteDeps {
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

export async function handleDemoRoute(demo: Demo, req: IncomingMessage, res: ServerResponse, url: URL, { sendJson, readJson }: RouteDeps): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/demo') sendJson(res, 200, demo.state());
    else if (route === 'POST /api/demo/start') {
      const body = (await readJson(req)) as { mode?: unknown } | null;
      sendJson(res, 200, await demo.startDemo(body?.mode));
    } else return false;
  } catch (err) {
    if (!(err instanceof DemoError)) throw err;
    sendJson(res, err.status, { error: err.message });
  }
  return true;
}
