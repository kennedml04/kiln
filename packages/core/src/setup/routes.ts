// The setup wizard's routes (ticket 25). All of them are Admin work (see access.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SetupError, type Setup } from './setup.ts';

interface RouteDeps {
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

export async function handleSetupRoute(setup: Setup, req: IncomingMessage, res: ServerResponse, url: URL, { sendJson, readJson }: RouteDeps): Promise<boolean> {
  if (url.pathname !== '/api/setup' && !url.pathname.startsWith('/api/setup/')) return false;
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/setup') sendJson(res, 200, await setup.state());
    else if (route === 'PUT /api/setup') sendJson(res, 200, await setup.update(await readJson(req)));
    else if (route === 'POST /api/setup/import') sendJson(res, 200, await setup.importOldBoard(await readJson(req)));
    else if (route === 'POST /api/setup/complete') sendJson(res, 200, await setup.complete());
    else return false;
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    sendJson(res, err.status, { error: err.message });
  }
  return true;
}
