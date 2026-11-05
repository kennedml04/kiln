// The access gate in front of every `/api/` route: who is calling, may they, and the audit entry.
//
// Routes don't check roles themselves. Every request is identified by the login adapter, matched
// against ACCESS_RULES (first match wins, otherwise reads need Viewer and changes need Member),
// CSRF-checked when it is a mutating request from a browser, and refused with 403 when the role
// is too low. Every mutating request and every refused request becomes one audit-log entry.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor, Role } from '@kiln/widget-sdk';
import type { AuditLog } from './audit.ts';
import { hostName, type LoginAdapter } from './login.ts';
import { hasRole, type UserStore } from './users.ts';

export const CSRF_HEADER = 'x-kiln-csrf';

/** Who needs what. `anyone` includes users with no role. */
export interface AccessRule {
  method: string;
  /** An exact path, or a pattern for paths with ids in them. */
  path: string | RegExp;
  role: Role | 'anyone';
  /** The audit action name. Defaults to `METHOD /path`. */
  action?: string;
}

/**
 * The access rules, first match wins. Add a rule only when a route needs more (or less) than the
 * default: GET needs Viewer, every other method needs Member.
 */
export const ACCESS_RULES: AccessRule[] = [
  { method: 'GET', path: '/api/me', role: 'anyone' },
  { method: 'POST', path: '/api/core/stop', role: 'admin', action: 'core.stop' },
  // Operations (ticket 26). Restarting the live core is a person's action.
  { method: 'POST', path: '/api/core/restart-when-idle', role: 'admin', action: 'core.restart_when_idle' },
  { method: 'DELETE', path: '/api/core/restart-when-idle', role: 'admin', action: 'core.restart_cancel' },
  { method: 'GET', path: '/api/doctor', role: 'admin' },
  { method: 'GET', path: '/api/users', role: 'admin' },
  { method: 'PUT', path: /^\/api\/users\/[^/]+$/, role: 'admin', action: 'user.set_role' },
  { method: 'GET', path: '/api/audit', role: 'admin' },
  // Widget installs (ticket 19). Every change is Admin work. The /api/widget/ routes check the
  // Widget's own credential themselves.
  { method: 'POST', path: '/api/widgets', role: 'admin', action: 'widget.install' },
  { method: 'POST', path: /^\/api\/widgets\/[^/]+\/approve$/, role: 'admin', action: 'widget.approve' },
  { method: 'POST', path: /^\/api\/widgets\/[^/]+\/start$/, role: 'admin', action: 'widget.start' },
  { method: 'POST', path: /^\/api\/widgets\/[^/]+\/stop$/, role: 'admin', action: 'widget.stop' },
  { method: 'POST', path: /^\/api\/widgets\/[^/]+\/update$/, role: 'admin', action: 'widget.update' },
  { method: 'DELETE', path: /^\/api\/widgets\/[^/]+$/, role: 'admin', action: 'widget.remove' },
  // Widget secrets (ticket 20): only Admins see which are set, or enter and remove them.
  { method: 'GET', path: /^\/api\/widgets\/[^/]+\/secrets$/, role: 'admin' },
  { method: 'PUT', path: /^\/api\/widgets\/[^/]+\/secrets\/[^/]+$/, role: 'admin', action: 'widget.secret_set' },
  { method: 'DELETE', path: /^\/api\/widgets\/[^/]+\/secrets\/[^/]+$/, role: 'admin', action: 'widget.secret_remove' },
  { method: 'GET', path: '/api/org-policy/widget-sources', role: 'admin' },
  { method: 'PUT', path: '/api/org-policy/widget-sources', role: 'admin', action: 'org_policy.widget_sources' },
  // Policy (ticket 12): only Admins change the Org Policy. Anyone with a role may read it.
  { method: 'PUT', path: '/api/org-policy', role: 'admin', action: 'org_policy.update' },
  { method: 'GET', path: /^\/api\/widget\//, role: 'anyone' },
  { method: 'POST', path: /^\/api\/widget\//, role: 'anyone' },
  { method: 'PUT', path: /^\/api\/widget\//, role: 'anyone' },
  // Widget panels (ticket 20): pressing a button runs a Widget's action, which is Member work.
  { method: 'POST', path: /^\/api\/widgets\/[^/]+\/actions\/[^/]+$/, role: 'member', action: 'widget.action' },
  // Ticket flow (ticket 05). Starting a Session is Member work, audited under its own name.
  { method: 'POST', path: /^\/api\/items\/[^/]+\/start$/, role: 'member', action: 'session.start' },
  // Threads (ticket 10). Chatting in an Item's Thread is Member work.
  { method: 'POST', path: /^\/api\/items\/[^/]+\/messages$/, role: 'member', action: 'thread.message' },
  // The Project Thread (ticket 13): chatting in it is Member work too.
  { method: 'POST', path: /^\/api\/projects\/[^/]+\/messages$/, role: 'member', action: 'project_thread.message' },
  // Scheduler (ticket 14). Pool sizes are Admin settings; Stop all, resume and reordering are Member work.
  { method: 'PUT', path: /^\/api\/scheduler\/pools\/[^/]+$/, role: 'admin', action: 'pool.set_size' },
  { method: 'PUT', path: '/api/scheduler/queue', role: 'member', action: 'queue.reorder' },
  { method: 'POST', path: '/api/scheduler/stop-all', role: 'member', action: 'scheduler.stop_all' },
  { method: 'POST', path: '/api/scheduler/resume', role: 'member', action: 'scheduler.resume' },
  // Kiln tools and Asks (ticket 06). The Kiln tools route checks the Session credential itself.
  { method: 'POST', path: '/api/kiln-tools', role: 'anyone', action: 'kiln_tools.call' },
  { method: 'GET', path: '/api/kiln-tools', role: 'anyone' },
  { method: 'POST', path: /^\/api\/asks\/[^/]+\/answer$/, role: 'member', action: 'ask.answer' },
  // Budgets (ticket 15). Setting caps and which models draw from which Budget is Admin work.
  { method: 'PUT', path: /^\/api\/budgets\/[^/]+$/, role: 'admin', action: 'budget.set' },
  { method: 'DELETE', path: /^\/api\/budgets\/[^/]+$/, role: 'admin', action: 'budget.remove' },
  // Setup (ticket 25): the wizard is Admin work, and Admins may run it again.
  { method: 'GET', path: '/api/setup', role: 'admin' },
  { method: 'PUT', path: '/api/setup', role: 'admin', action: 'setup.update' },
  { method: 'POST', path: '/api/setup/import', role: 'admin', action: 'setup.import' },
  { method: 'POST', path: '/api/setup/complete', role: 'admin', action: 'setup.complete' },
  // The demo Project on a dev instance (demo-project Ticket 05): starting it is Admin work.
  { method: 'GET', path: '/api/demo', role: 'admin' },
  { method: 'POST', path: '/api/demo/start', role: 'admin', action: 'demo.start' },
  // Runaway guards (ticket 16). The stall and context-alarm thresholds are Admin settings.
  { method: 'PUT', path: '/api/runaway', role: 'admin', action: 'runaway.set' },
  // Variants and the local server (local-first Ticket 04): Admin settings, like Budgets.
  { method: 'PUT', path: '/api/local-server', role: 'admin', action: 'local_server.set' },
  { method: 'POST', path: '/api/variants', role: 'admin', action: 'variant.add' },
  { method: 'PATCH', path: /^\/api\/variants\/[^/]+$/, role: 'admin', action: 'variant.edit' },
  { method: 'DELETE', path: /^\/api\/variants\/[^/]+$/, role: 'admin', action: 'variant.remove' },
  { method: 'POST', path: /^\/api\/variants\/[^/]+\/(enable|disable|smoke-test)$/, role: 'admin', action: 'variant.change' },
];

export interface Caller {
  actor: Actor;
  role: Role | null;
  /**
   * For callers whose rights come from grants rather than a role (Widgets): whether this request
   * is inside them. Asked for every route that isn't open to `anyone`; a no is refused as `grant`.
   */
  authorize?: (method: string, url: URL) => boolean;
}

/** Extra facts a handler adds to its request's audit entry. */
export interface AuditNote {
  action?: string;
  target?: string;
  detail?: unknown;
  /** Record the request as refused (a rule said no), not failed, when it ends in an error. */
  refused?: { reason: string };
}

/**
 * Recognises a caller by a credential (for example a Widget's bearer token) before the login
 * adapter is asked. Return undefined to pass. Such callers are not browsers, so need no CSRF token.
 */
export type Authenticator = (req: IncomingMessage) => Caller | undefined;

export interface Access {
  /** The per-core CSRF token, handed to the Shell by `GET /api/me`. */
  csrfToken: string;
  /** Registers a credential check that runs before the login adapter, in the order added. */
  addAuthenticator(authenticator: Authenticator): void;
  /**
   * Identifies and checks one `/api/` request. Returns the caller when it may proceed; otherwise
   * it has already answered 403 and audited the refusal, and the route must not run.
   */
  admit(req: IncomingMessage, res: ServerResponse): Promise<Caller | undefined>;
  /** The caller of an admitted request. */
  caller(req: IncomingMessage): Caller;
  /** Adds a target, detail or a better action name to this request's audit entry. */
  note(req: IncomingMessage, note: AuditNote): void;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Browsers always send Origin or Sec-Fetch-* on these requests, and a page can't remove them. */
const fromBrowser = (req: IncomingMessage) => req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined;

const matches = (rule: AccessRule, method: string, path: string) =>
  rule.method === method && (typeof rule.path === 'string' ? rule.path === path : rule.path.test(path));

export function createAccess(deps: { login: LoginAdapter; users: UserStore; audit: AuditLog; rules?: AccessRule[] }): Access {
  const rules = deps.rules ?? ACCESS_RULES;
  const csrfToken = randomBytes(32).toString('base64url');
  const expected = Buffer.from(csrfToken);
  const callers = new WeakMap<IncomingMessage, Caller>();
  const notes = new WeakMap<IncomingMessage, AuditNote>();

  const csrfValid = (req: IncomingMessage) => {
    const sent = req.headers[CSRF_HEADER];
    if (typeof sent !== 'string') return false;
    const given = Buffer.from(sent);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const authenticators: Authenticator[] = [];

  /** The caller, and whether they proved who they are with a credential rather than by network. */
  const identify = async (req: IncomingMessage): Promise<Caller & { credential?: true }> => {
    for (const authenticate of authenticators) {
      const caller = authenticate(req);
      if (caller) return { ...caller, credential: true };
    }
    const identity = await deps.login.identify(req);
    if (identity === 'local') return { actor: { kind: 'user', id: 'local' }, role: 'admin' };
    if (identity === undefined) return { actor: { kind: 'user', id: `unknown:${req.socket.remoteAddress ?? '?'}` }, role: null };
    const user = deps.users.seen(identity.id, identity.name);
    const actor: Actor = user.name ? { kind: 'user', id: user.id, name: user.name } : { kind: 'user', id: user.id };
    return { actor, role: user.role };
  };

  const refuse = (res: ServerResponse, reason: string, error: string) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error, reason }));
  };

  return {
    csrfToken,

    addAuthenticator(authenticator) {
      authenticators.push(authenticator);
    },

    async admit(req, res) {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const rule = rules.find((r) => matches(r, method, path));
      const mutating = MUTATING.has(method);
      const needed = rule?.role ?? (mutating ? 'member' : 'viewer');
      const caller = await identify(req);
      const base = { actor: caller.actor, action: rule?.action ?? `${method} ${path}`, method, path };

      let refusal: { reason: string; error: string } | undefined;
      if (!deps.login.acceptsHost(hostName(req.headers.host))) {
        refusal = { reason: 'host', error: 'Kiln does not answer to this host name.' };
      } else if (needed !== 'anyone' && caller.authorize) {
        if (!caller.authorize(method, url)) refusal = { reason: 'grant', error: `${method} ${path} is outside what this Widget was granted.` };
      } else if (needed !== 'anyone' && caller.role === null) {
        refusal = { reason: 'no-role', error: 'You have no access yet. An Admin must give you a role.' };
      } else if (needed !== 'anyone' && !hasRole(caller.role, needed)) {
        refusal = { reason: 'role', error: `This needs the ${needed} role; you are ${caller.role}.` };
      } else if (mutating && !caller.credential && fromBrowser(req) && !csrfValid(req)) {
        refusal = { reason: 'csrf', error: `Missing or wrong ${CSRF_HEADER} header. Reload the page.` };
      }
      if (refusal) {
        deps.audit.record({ ...base, outcome: 'refused', status: 403, reason: refusal.reason });
        refuse(res, refusal.reason, refusal.error);
        return undefined;
      }

      callers.set(req, { actor: caller.actor, role: caller.role, ...(caller.authorize ? { authorize: caller.authorize } : {}) });
      // Mutating requests are always audited; a read only when the route refused it (e.g. a grant).
      res.once('finish', () => {
        const note = notes.get(req) ?? {};
        if (!mutating && !(note.refused && res.statusCode >= 400)) return;
        deps.audit.record({
          ...base,
          ...(note.action ? { action: note.action } : {}),
          ...(note.target !== undefined ? { target: note.target } : {}),
          ...(note.detail !== undefined ? { detail: note.detail } : {}),
          outcome: res.statusCode < 400 ? 'allowed' : note.refused ? 'refused' : 'failed',
          ...(res.statusCode >= 400 && note.refused ? { reason: note.refused.reason } : {}),
          status: res.statusCode,
        });
      });
      return caller;
    },

    caller(req) {
      const caller = callers.get(req);
      if (!caller) throw new Error('caller() on a request the access gate did not admit');
      return caller;
    },

    note(req, note) {
      notes.set(req, { ...notes.get(req), ...note });
    },
  };
}
