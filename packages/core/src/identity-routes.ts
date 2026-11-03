// Core API routes for identity, users and the audit log. Access rules for them live in access.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor, AuditOutcome, AuditQuery, Me } from '@kiln/widget-sdk';
import type { Access } from './access.ts';
import type { AuditLog } from './audit.ts';
import type { LoginAdapter } from './login.ts';
import { isRole, type UserStore } from './users.ts';

export interface IdentityRouteDeps {
  access: Access;
  audit: AuditLog;
  users: UserStore;
  login: LoginAdapter;
  sendJson(res: ServerResponse, code: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

const USER_PATH = /^\/api\/users\/([^/]+)$/;
const ACTOR_KINDS: Actor['kind'][] = ['user', 'session', 'widget', 'kiln'];
const OUTCOMES: AuditOutcome[] = ['allowed', 'refused', 'failed'];

function auditQuery(params: URLSearchParams): AuditQuery {
  const query: AuditQuery = {};
  const kind = params.get('actorKind');
  if (kind && (ACTOR_KINDS as string[]).includes(kind)) query.actorKind = kind as Actor['kind'];
  const outcome = params.get('outcome');
  if (outcome && (OUTCOMES as string[]).includes(outcome)) query.outcome = outcome as AuditOutcome;
  for (const key of ['actorId', 'action', 'since', 'until'] as const) {
    const value = params.get(key);
    if (value) query[key] = value;
  }
  const limit = Number(params.get('limit'));
  if (Number.isFinite(limit) && limit > 0) query.limit = limit;
  return query;
}

/** Answers the identity routes. Returns false when the request is not one of them. */
export async function handleIdentityRoute(req: IncomingMessage, res: ServerResponse, url: URL, deps: IdentityRouteDeps): Promise<boolean> {
  const { access, sendJson } = deps;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/me') {
    const caller = access.caller(req);
    const me: Me = { login: deps.login.mode, actor: caller.actor, role: caller.role, csrfToken: access.csrfToken };
    sendJson(res, 200, me);
    return true;
  }

  if (route === 'GET /api/users') {
    sendJson(res, 200, deps.users.list());
    return true;
  }

  const userMatch = req.method === 'PUT' ? USER_PATH.exec(url.pathname) : null;
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1]!);
    const body = (await deps.readJson(req)) as { role?: unknown; name?: unknown } | null;
    const role = body?.role;
    if (role !== null && !isRole(role)) {
      sendJson(res, 400, { error: 'role must be admin, member, viewer or null' });
      return true;
    }
    if (id === 'local') {
      sendJson(res, 400, { error: 'The local person is always Admin' });
      return true;
    }
    const before = deps.users.get(id)?.role ?? null;
    const name = typeof body?.name === 'string' ? body.name : undefined;
    const user = deps.users.setRole(id, role, name);
    access.note(req, { target: `user:${id}`, detail: { from: before, to: role } });
    sendJson(res, 200, user);
    return true;
  }

  if (route === 'GET /api/audit') {
    sendJson(res, 200, deps.audit.query(auditQuery(url.searchParams)));
    return true;
  }

  return false;
}
