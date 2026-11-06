// Core API routes for the local server and its variants (local-first Ticket 04).
//   GET    /api/local-server               LocalServerSettings
//   PUT    /api/local-server               Partial<LocalServerSettings> (Admin; null clears configPath or url)
//   GET    /api/variants                   VariantList (recorded variants, removed ones too, and the server's unrecorded entries)
//   GET    /api/variants/:id               Variant
//   POST   /api/variants                   AddVariantRequest (Admin) -> 201 Variant, after the write, reload and smoke test
//   PATCH  /api/variants/:id               EditVariantRequest (Admin) -> Variant
//   DELETE /api/variants/:id               (Admin) -> Variant (state removed; the record stays)
//   POST   /api/variants/:id/enable        (Admin) -> Variant
//   POST   /api/variants/:id/disable       DisableVariantRequest (Admin) -> Variant
//   POST   /api/variants/:id/smoke-test    (Admin) -> Variant
// Add a model (local-first Ticket 06), every one Admin:
//   POST   /api/local-models/inspect               InspectModelRequest -> ModelInspection
//   GET    /api/local-models/huggingface?repo=a/b  HuggingFaceFiles (the repo's GGUF files and sizes)
//   POST   /api/local-models/downloads             StartDownloadRequest -> 202 ModelDownload (resumes a part file)
//   GET    /api/local-models/downloads             ModelDownload[]
//   GET    /api/local-models/downloads/:id         ModelDownload
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DisableVariantRequest } from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { LocalModels } from './models.ts';
import type { Routing } from './routing.ts';
import type { VariantService } from './variants.ts';

const VARIANT = /^\/api\/variants\/([^/]+)$/;
const ACTION = /^\/api\/variants\/([^/]+)\/(enable|disable|smoke-test)$/;
const DOWNLOAD = /^\/api\/local-models\/downloads\/([^/]+)$/;

/** Answers the request if it is an Add a model route; returns false otherwise. */
export async function handleLocalModelRoute(
  models: LocalModels,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/local-models/')) return false;
  try {
    const route = `${req.method} ${path}`;
    if (route === 'POST /api/local-models/inspect') return (sendJson(res, 200, await models.inspect(await readJson(req))), true);
    if (route === 'GET /api/local-models/huggingface') return (sendJson(res, 200, await models.huggingFaceFiles(url.searchParams.get('repo'))), true);
    if (route === 'POST /api/local-models/downloads') return (sendJson(res, 202, await models.startDownload(await readJson(req))), true);
    if (route === 'GET /api/local-models/downloads') return (sendJson(res, 200, models.downloads()), true);
    const one = DOWNLOAD.exec(path);
    if (one && req.method === 'GET') return (sendJson(res, 200, models.download(decodeURIComponent(one[1]!))), true);
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}

/** Answers the request if it is a local server or variant route; returns false otherwise. */
export async function handleVariantRoute(
  variants: VariantService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/local-server' && !path.startsWith('/api/variants')) return false;
  try {
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/local-server') return (sendJson(res, 200, variants.settings()), true);
    if (route === 'PUT /api/local-server') return (sendJson(res, 200, variants.setSettings(await readJson(req))), true);
    if (route === 'GET /api/variants') return (sendJson(res, 200, await variants.list()), true);
    if (route === 'POST /api/variants') return (sendJson(res, 201, await variants.add(await readJson(req))), true);
    const one = VARIANT.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      if (req.method === 'GET') return (sendJson(res, 200, await variants.get(id)), true);
      if (req.method === 'PATCH') return (sendJson(res, 200, await variants.edit(id, await readJson(req))), true);
      if (req.method === 'DELETE') return (sendJson(res, 200, await variants.remove(id)), true);
    }
    const action = ACTION.exec(path);
    if (action && req.method === 'POST') {
      const id = decodeURIComponent(action[1]!);
      if (action[2] === 'enable') return (sendJson(res, 200, await variants.enable(id)), true);
      if (action[2] === 'smoke-test') return (sendJson(res, 200, await variants.smokeTest(id)), true);
      const body = ((await readJson(req)) ?? {}) as DisableVariantRequest;
      if (body.reason !== undefined && typeof body.reason !== 'string') throw new WorkError(400, '"reason" must be text');
      return (sendJson(res, 200, await variants.disable(id, body.reason)), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}

/** Answers the request if it is a routing route (results, pins, the install-wide switch); false otherwise. */
export async function handleRoutingRoute(
  routing: Routing,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/local-routing') return (sendJson(res, 200, routing.routing()), true);
    if (route === 'PUT /api/local-routing') return (sendJson(res, 200, routing.update(await readJson(req))), true);
    if (route === 'GET /api/variant-results') return (sendJson(res, 200, routing.results(url.searchParams.get('variantId') ?? undefined)), true);
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
