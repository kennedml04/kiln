// Core API routes for the archive (Reset board).
//   POST /api/archive/reset {projectId?}          Member -> {batchId, count, itemIds}
//   POST /api/archive/unarchive {batchId|itemIds}  Member -> {itemIds}
//   GET  /api/archive?projectId=&q=                Viewer -> {batches}
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArchiveResetRequest, UnarchiveRequest } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import type { ArchiveService } from './archive.ts';
import type { RouteHelpers } from './routes.ts';
import { WorkError } from './work.ts';

export async function handleArchiveRoute(
  archive: ArchiveService,
  access: Access,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/archive')) return false;
  try {
    const actor = () => access.caller(req).actor;
    if (path === '/api/archive' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId') || undefined;
      const q = url.searchParams.get('q') || undefined;
      return (sendJson(res, 200, { batches: archive.history({ projectId, q }) }), true);
    }
    if (path === '/api/archive/reset' && req.method === 'POST') {
      const body = ((await readJson(req)) ?? {}) as ArchiveResetRequest;
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined;
      access.note(req, { target: projectId ? `project:${projectId}` : 'all' });
      const result = archive.reset({ actor: actor(), projectId });
      access.note(req, { detail: { batchId: result.batchId, count: result.count } });
      return (sendJson(res, 200, result), true);
    }
    if (path === '/api/archive/unarchive' && req.method === 'POST') {
      const body = ((await readJson(req)) ?? {}) as UnarchiveRequest;
      const itemIds = archive.unarchive({ actor: actor(), batchId: body.batchId, itemIds: body.itemIds });
      access.note(req, {
        target: body.batchId ? `batch:${body.batchId}` : 'items',
        detail: { ...(body.batchId ? { batchId: body.batchId } : {}), itemIds, count: itemIds.length },
      });
      return (sendJson(res, 200, { itemIds }), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
