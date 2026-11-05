// The Kiln core API contract, shared by the core, the Shell and Widgets.
// Every type that crosses the core API boundary is defined here once.
import type { AgentEvent, AgentRegistration } from './agent.ts';

export * from './manifest.ts';
export * from './panel.ts';
export * from './widget-events.ts';
export * from './agent.ts';
export * from './widget-api.ts';
export { readSse } from './sse.ts';
export { createWidgetClient, serveAgent, widgetContext, type WidgetClient, type WidgetContext } from './client.ts';

export const CORE_API_VERSION = '0.1.0';

/** GET /api/status */
export interface CoreStatus {
  name: 'Kiln';
  apiVersion: string;
  pid: number;
  port: number;
  dataDir: string;
  startedAt: string;
  uptimeMs: number;
  /** Set while "Restart when idle" waits for running Sessions to finish. */
  restartPending?: RestartPending;
  /** `dev` for a dev instance started by `kiln dev`, `live` otherwise. */
  instance: 'live' | 'dev';
}

/** POST /api/core/restart-when-idle answers with this (202), and GET /api/status carries it while pending. */
export interface RestartPending {
  requestedAt: string;
  /** Sessions Kiln is still waiting for. */
  runningSessions: number;
}

/** "Restart when idle" was asked for; Kiln restarts once no Session runs. */
export type CoreRestartPendingEvent = KilnEvent<'core.restart_pending', RestartPending>;
/** Kiln is about to stop and start again (no Session was running). */
export type CoreRestartingEvent = KilnEvent<'core.restarting', { requestedAt: string }>;
/** A pending restart was called off (DELETE /api/core/restart-when-idle). */
export type CoreRestartCancelledEvent = KilnEvent<'core.restart_cancelled', { requestedAt: string }>;

/** How a `kiln doctor` check came out. `not-configured`: the part it checks isn't set up (or built) yet. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'not-configured';

/** One `kiln doctor` check. Every `warn` and `fail` has a plain `fix`. */
export interface DoctorCheckResult {
  id: string;
  name: string;
  status: DoctorStatus;
  /** What was found, in plain words. */
  detail: string;
  /** What to do about it. */
  fix?: string;
}

/** GET /api/doctor (Admin): the checks only the running core can make. */
export interface DoctorReport {
  checks: DoctorCheckResult[];
}

/**
 * One event on the event bus. Every state change becomes one of these,
 * stored in SQLite and pushed to the Shell over SSE (`GET /api/events`)
 * as unnamed SSE messages: `id: <id>` and `data: <JSON of the whole KilnEvent>`.
 * Clients switch on `type`, so one `onmessage` handler sees every event.
 */
export interface KilnEvent<T extends string = string, P = unknown> {
  id: number;
  type: T;
  at: string;
  payload: P;
}

/** How people are identified: Local (localhost only, the local person is Admin) or Tailscale. */
export type LoginMode = 'local' | 'tailscale';

/** Admin > Member > Viewer. A user with no role (`null`) has no access. */
export type Role = 'admin' | 'member' | 'viewer';

/** Who did something. Every audit entry has one. */
export type Actor =
  | { kind: 'user'; id: string; name?: string }
  | { kind: 'session'; id: string; agent: string }
  | { kind: 'widget'; id: string }
  | { kind: 'kiln' };

/** GET /api/me: who the caller is. Answered for everyone, including users with no role. */
export interface Me {
  login: LoginMode;
  actor: Actor;
  role: Role | null;
  /** Send back as the `x-kiln-csrf` header on every mutating request from a browser. */
  csrfToken: string;
}

/** A known user. Tailnet users who connected without a role are listed with `role: null`. */
export interface User {
  id: string;
  name?: string;
  role: Role | null;
  firstSeen: string;
  lastSeen: string;
}

/** PUT /api/users/:id */
export interface SetUserRole {
  role: Role | null;
  name?: string;
}

export type AuditOutcome = 'allowed' | 'refused' | 'failed';

/** One row of the append-only audit log (GET /api/audit). */
export interface AuditEntry {
  id: number;
  at: string;
  actor: Actor;
  /** What was attempted, e.g. `core.stop` or `POST /api/test/echo`. */
  action: string;
  method?: string;
  path?: string;
  target?: string;
  outcome: AuditOutcome;
  status?: number;
  /** Why it was refused or failed, when it was. */
  reason?: string;
  detail?: unknown;
}

/** Query string filters of GET /api/audit. All optional; newest first. */
export interface AuditQuery {
  actorKind?: Actor['kind'];
  actorId?: string;
  action?: string;
  outcome?: AuditOutcome;
  since?: string;
  until?: string;
  limit?: number;
}

/** Sent first on every SSE connection. */
export type CoreHelloEvent = KilnEvent<'core.hello', { startedAt: string }>;

/** Raised by `POST /api/test/echo`, which exists only on a core started in test mode. */
export type TestEchoEvent = KilnEvent<'test.echo', unknown>;

export * from './work.ts';
export * from './flow.ts';
export * from './asks.ts';
export * from './policy.ts';
export * from './scheduler.ts';
export * from './budgets.ts';
export * from './runaway.ts';
export * from './threads.ts';
export * from './project-thread.ts';
export * from './setup.ts';
export * from './demo.ts';
export * from './tracker-widget.ts';
export type WidgetStartedEvent = KilnEvent<'widget.started', { widgetId: string; pid: number | null }>;
export type WidgetRegisteredEvent = KilnEvent<
  'widget.registered',
  { widgetId: string; name: string; version: string; agents: AgentRegistration[] }
>;
export type WidgetReadyEvent = KilnEvent<'widget.ready', { widgetId: string }>;
export type WidgetStoppedEvent = KilnEvent<'widget.stopped', { widgetId: string }>;
/** The Widget process ended without being asked to. */
export type WidgetExitedEvent = KilnEvent<'widget.exited', { widgetId: string; code: number | null }>;

/**
 * An Agent event, published as `agent.<kind>` (e.g. `agent.progress`, `agent.finished`)
 * with the Widget and Session it came from.
 */
export type AgentKilnEvent<K extends AgentEvent['kind'] = AgentEvent['kind']> = KilnEvent<
  `agent.${K}`,
  Extract<AgentEvent, { kind: K }> & { widgetId: string; sessionId: string }
>;
