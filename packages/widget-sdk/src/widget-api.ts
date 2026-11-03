// The Widget API: how a Widget process and the core talk.
//
// The core starts a Widget with a minimal environment: the OS basics (PATH, SystemRoot, TEMP, the
// user's profile folders, proxy settings) and these, never the core's own tokens or settings:
//   KILN_API_URL          the core API's address, e.g. http://127.0.0.1:51234
//   KILN_WIDGET_ID        the Widget's id (from its Manifest)
//   KILN_WIDGET_TOKEN     its per-Widget credential, sent as `authorization: Bearer <token>`
//   KILN_WIDGET_DATA_DIR  its own data folder, only when its Manifest's `needs.dataFolder` asks for one
//   KILN_WIDGET_CONFIG    JSON config given at install (`{}` when none)
// A secret a Widget needs comes from the Platform (`needs.secrets`), not from the environment.
//
// Widget routes, all needing the credential (401 without it):
//   GET  /api/widget/commands      SSE stream of WidgetCommand (unnamed `data:` JSON messages)
//   POST /api/widget/register      body RegisterRequest; 403 for an Agent not in the Manifest
//   POST /api/widget/ready
//   POST /api/widget/agent-events  body AgentEventReport
//   POST /api/widget/asks          body WidgetRaiseAskRequest -> 201 Ask; the answer comes back
//                                  down the command stream as `ask.answered` (again if it changes)
//   GET  /api/widget/events?types=a,b   SSE of the KilnEvents its grants allow (see widget-events.ts)
//   PUT  /api/widget/panels/:panelId    body PanelContent (see panel.ts)
//   POST /api/widget/panels/:panelId/messages   any JSON, to its embedded page
//   GET  /api/widget/secrets/:name      SecretValue (see WidgetSecrets below)
//   POST /api/widget/replies            body WidgetReply, answering a `widget.request` command
//   POST /api/widget/trackers/changed, GET /api/widget/pull-requests,
//   POST /api/widget/pull-requests/merged   for Tracker and pull-request Widgets (tracker-widget.ts)
//
// A Widget calling any other route is refused (403, reason `grant`) and audited unless its approved
// grants cover it. Today the only grantable routes are the Work reads and writes its Manifest's
// `needs.work` declares, scoped by Project. Event types, panels, actions and secrets are checked
// against its grants and Manifest by the routes above.
//
// Shell routes for panels: GET /api/panels (PanelView[]), POST /api/widgets/:id/actions/:action
// (Member; body ActionRequest -> 202) and GET /api/widgets/:id/pages/:panelId/<file> (sandboxed).
//
// Admin routes (reads need Viewer, every change needs Admin):
//   GET    /api/widgets                 WidgetInfo[], every install whatever its state
//   POST   /api/widgets                 body InstallWidgetRequest -> 201 WidgetInfo, `awaiting-approval`
//                                       (403 when the Org Policy doesn't allow the source, 409 if installed)
//   POST   /api/widgets/:id/approve     grants what the Manifest (or the pending update) asks, then starts it
//   POST   /api/widgets/:id/start       starts an approved Widget (409 when incompatible or unapproved)
//   POST   /api/widgets/:id/stop        stops it; it stays installed
//   POST   /api/widgets/:id/update      body UpdateWidgetRequest; re-resolves the source. Swaps at once
//                                       when it needs nothing new, else waits as `pendingUpdate`
//   DELETE /api/widgets/:id             stops and removes it (its data folder is kept)
//   GET    /api/org-policy/widget-sources   WidgetSourcePolicy
//   PUT    /api/org-policy/widget-sources   body WidgetSourcePolicy
//   POST   /api/test/widgets/:id/commands  (test mode only) body AgentCommand, pushed to the Widget

import type { AgentCommand, AgentEvent, AgentRegistration } from './agent.ts';
import type { Ask } from './asks.ts';
import type { Manifest, WidgetNeeds } from './manifest.ts';
import type { WidgetActionCommand } from './panel.ts';
import type { WidgetRequestCommand } from './tracker-widget.ts';

export const WIDGET_ENV = {
  apiUrl: 'KILN_API_URL',
  widgetId: 'KILN_WIDGET_ID',
  token: 'KILN_WIDGET_TOKEN',
  dataDir: 'KILN_WIDGET_DATA_DIR',
  config: 'KILN_WIDGET_CONFIG',
} as const;

/**
 * Sent down a Widget's command stream. `widget.stop` asks it to exit cleanly; `widget.action` is a
 * panel button or embedded page running one of its named actions; `ask.answered` delivers a
 * person's answer to an Ask the Widget raised.
 */
export type WidgetCommand =
  | AgentCommand
  | WidgetActionCommand
  | WidgetRequestCommand
  | { type: 'widget.stop' }
  | { type: 'ask.answered'; ask: Ask };

export interface RegisterRequest {
  agents?: AgentRegistration[];
}

export interface AgentEventReport {
  sessionId: string;
  event: AgentEvent;
}

export interface InstallWidgetRequest {
  /**
   * Where to install from. A git repo (a URL, or a local folder with `.git` at its root) is cloned
   * and pinned to a commit. Any other local folder runs in place, pinned to a hash of its files.
   */
  source: string;
  /** Git only: the branch, tag or commit to resolve (default: the source's HEAD). */
  ref?: string;
  /** The Widget's folder inside the source, for a repo holding several (e.g. `widgets/gpu`). */
  path?: string;
  /** Passed to the Widget as KILN_WIDGET_CONFIG. */
  config?: unknown;
}

export interface UpdateWidgetRequest {
  /** Git only: resolve this ref instead of the one installed. */
  ref?: string;
}

/** Exactly what is installed. Written to `<data dir>/widgets.lock.json`. */
export interface WidgetPin {
  kind: 'git' | 'folder';
  /** As given at install (local paths made absolute). */
  source: string;
  path?: string;
  /** The ref asked for (git), kept for updates. */
  ref?: string;
  /** The exact commit (git). */
  commit?: string;
  /** A tag pointing at that commit, if there is one (git). */
  tag?: string;
  /** `sha256:<hex>` of the Widget folder's files (folder sources, which run in place). */
  hash?: string;
}

export interface WidgetLockEntry extends WidgetPin {
  version: string;
  lockedAt: string;
}

export interface WidgetLockfile {
  lockfileVersion: 1;
  widgets: Record<string, WidgetLockEntry>;
}

/** What an Admin granted: the `needs` and `pools` of the Manifest they approved. */
export interface WidgetGrants {
  needs: WidgetNeeds;
  pools: Record<string, number>;
  approvedBy: string;
  approvedAt: string;
}

/**
 * - `awaiting-approval`: installed, never approved; nothing runs.
 * - `incompatible`: its `coreApi` range excludes this core; it is never started (see `problem`).
 * - `restarting`: it crashed and will be started again after a backoff.
 * - `unhealthy`: it crashed too many times in a row; Kiln stopped trying (start it again by hand).
 */
export type WidgetState =
  | 'awaiting-approval'
  | 'incompatible'
  | 'starting'
  | 'registered'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'restarting'
  | 'unhealthy';

/** An update that asks for more than was approved, waiting for an Admin. */
export interface PendingWidgetUpdate {
  manifest: Manifest;
  pin: WidgetPin;
  /** What it asks for beyond the current grants, in words, e.g. `network: api.example.com`. */
  newNeeds: string[];
}

export interface WidgetInfo {
  id: string;
  name: string;
  version: string;
  /** Where its code runs from: the clone in the data folder, or the source folder itself. */
  folder: string;
  pin: WidgetPin;
  manifest: Manifest;
  /** Null until an Admin approves. */
  grants: WidgetGrants | null;
  pendingUpdate: PendingWidgetUpdate | null;
  state: WidgetState;
  /** Why it isn't running when it should be: incompatible, crashing, or its folder changed. */
  problem: string | null;
  /** Crash restarts since it was last started by hand or stayed up. */
  restarts: number;
  pid: number | null;
  agents: AgentRegistration[];
}

/**
 * Widget secrets. The Manifest names them (`needs.secrets`); an Admin enters each value; the
 * Platform keeps it in the OS credential store (never in SQLite, the audit log or a file) and hands
 * it only to that Widget, and only once its grants include the name.
 *   GET    /api/widgets/:id/secrets         (Admin) WidgetSecrets: which are set, never the values
 *   PUT    /api/widgets/:id/secrets/:name   (Admin) body SetSecretRequest; 404 if the Manifest doesn't name it
 *   DELETE /api/widgets/:id/secrets/:name   (Admin)
 *   GET    /api/widget/secrets/:name        (the Widget) SecretValue; 403 `grant` if not granted, 404 if unset
 * Removing a Widget removes its secrets.
 */
export interface SetSecretRequest {
  value: string;
}

export interface SecretValue {
  name: string;
  value: string;
}

export interface WidgetSecretEntry {
  name: string;
  set: boolean;
  /** Where the OS credential store keeps it (Windows: a Credential Locker resource and user name). */
  location: { resource: string; account: string };
}

export interface WidgetSecrets {
  /** Which OS credential store holds them, e.g. `windows-credential-locker` or `macos-keychain`. */
  store: string;
  entries: WidgetSecretEntry[];
}

/** The Org Policy's say on Widget sources. `allowed: null` allows any source. */
export interface WidgetSourcePolicy {
  /** Allowed sources: an exact source, a folder (covers everything inside it) or a prefix ending in `*`. */
  allowed: string[] | null;
}
