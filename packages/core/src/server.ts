import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  CORE_API_VERSION,
  type AgentEventReport,
  type CoreStatus,
  type KilnEvent,
  type RegisterRequest,
  type PullRequestMergedRequest,
  type TrackerChangedRequest,
  type WidgetCommand,
  type WidgetReply,
  type WidgetRaiseAskRequest,
} from '@kiln/widget-sdk';
import type { CoreConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createEventBus } from './events.ts';
import { createAccess } from './access.ts';
import { createAuditLog } from './audit.ts';
import { createAskService } from './asks/ask-service.ts';
import { createProposalApplier } from './flow/proposals.ts';
import { handleAskRoute } from './asks/routes.ts';
import { handleFlowRoute } from './flow/routes.ts';
import { createGates } from './flow/gates.ts';
import { createScheduler } from './flow/scheduler.ts';
import { createRollUp } from './flow/roll-up.ts';
import { handleSchedulerRoute } from './flow/scheduler-routes.ts';
import { answerKilnTools, calledTool, KILN_TOOLS_PATH, kilnToolsTarget } from './flow/kiln-tools.ts';
import { createSessionManager } from './flow/session-manager.ts';
import { createMovableKnowledgeStore } from './knowledge/markdown-store.ts';
import { handleIdentityRoute } from './identity-routes.ts';
import { createPolicyEngine } from './policy/policy.ts';
import { handlePolicyRoute } from './policy/routes.ts';
import { createLoginAdapter } from './login.ts';
import { createUserStore } from './users.ts';
import { handleWorkRoute } from './work/routes.ts';
import { createWork, WorkError } from './work/work.ts';
import { createWidgetHost, WidgetHostError } from './widget-host.ts';
import { createWidgetLifecycle } from './widgets/lifecycle.ts';
import { createWidgetBridge } from './widgets/bridge.ts';
import { createWidgetTracker } from './work/widget-tracker.ts';
import { createPullRequests } from './flow/pull-requests.ts';
import { handleWidgetRoute } from './widgets/routes.ts';
import { handlePanelRoute } from './widgets/panel-routes.ts';
import { memoryCredentialStore, osCredentialStore } from './secrets/os-credential-store.ts';
import { createWidgetSecrets, handleSecretRoute } from './secrets/secrets.ts';
import { createWidgetPanels } from './widgets/panels.ts';
import { createRestartWhenIdle } from './operations/restart.ts';
import { agentsCheck, createDoctor, notConfigured, widgetsCheck } from './operations/doctor.ts';
import { createProxyWatch } from './operations/proxy.ts';
import { createClock } from './clock.ts';
import { createUsageService } from './budgets/usage.ts';
import { handleBudgetRoute } from './budgets/routes.ts';
import { createStageModels } from './budgets/stage-models.ts';
import { createSetup, readSetupSettings } from './setup/setup.ts';
import { handleSetupRoute } from './setup/routes.ts';
import { createRunawayGuard, handleRunawayRoute } from './budgets/runaway.ts';

/** Where the built Shell lives in the monorepo (`npm run build` writes it). */
export const DEFAULT_SHELL_DIR = fileURLToPath(new URL('../../shell/dist/', import.meta.url));

const HEARTBEAT_MS = 15_000;

const bearer = (req: IncomingMessage) => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export interface CoreOptions extends CoreConfig {
  shellDir?: string;
  /** Called when a client asks the core to stop (`POST /api/core/stop`). */
  onStopRequested?: () => void;
  /**
   * Called when "Restart when idle" finds no Session running: stop this core and start a fresh
   * one in its place (main.ts does it). Without it, the core only stops.
   */
  onRestartRequested?: () => void;
}

export interface RunningCore {
  status(): CoreStatus;
  stop(): Promise<void>;
}

/** Starts the core: opens its SQLite file, then serves the core API, the event stream and the Shell. */
export async function startCore(options: CoreOptions): Promise<RunningCore> {
  const db = openDatabase(options.dataDir);
  const bus = createEventBus(db);
  const audit = createAuditLog(db);
  const users = createUserStore(db);
  // What setup stored applies unless the login mode or Knowledge store folder was given at start.
  const stored = readSetupSettings(db);
  const loginMode = (options.defaulted?.login && stored.login) || options.login;
  const knowledgeDir = (options.defaulted?.knowledgeDir && stored.knowledgeDir) || options.knowledgeDir;
  const login = createLoginAdapter({ mode: loginMode, testMode: options.testMode });
  const access = createAccess({ login, users, audit });
  const widgets = createWidgetHost(bus, options.dataDir);
  let port = options.port;
  const installs = createWidgetLifecycle({
    db,
    bus,
    host: widgets,
    dataDir: options.dataDir,
    apiUrl: () => `http://127.0.0.1:${port}`,
    restartMs: options.widgetRestartMs,
    onRemove: (widget) => secrets.removeAll(widget),
  });
  const secrets = createWidgetSecrets({
    // A test core never touches the real credential store (only the gated real-store test asks for it).
    store: options.testMode && process.env.KILN_TEST_OS_CREDENTIALS !== '1' ? memoryCredentialStore() : osCredentialStore(),
    dataDir: options.dataDir,
    widget: (id) => installs.list().find((w) => w.id === id),
    granted: (id) => installs.grantedSecrets(id),
  });
  // Tracker and pull-request Widgets (ticket 24) answer the core's requests through the bridge. It
  // exists before Work, which opens the stored Projects (and their Trackers) at once.
  const bridge = createWidgetBridge({ bus, host: widgets, widgets: () => installs.list() });
  const work = createWork(db, bus, { widgetTracker: (project) => createWidgetTracker(bridge, project) });
  const policy = createPolicyEngine({
    db,
    bus,
    sources: { get: () => installs.sourcePolicy(), set: (p) => installs.setSourcePolicy(p) },
  });
  work.onRegister((project) => policy.writeTemplate(project));
  const asks = createAskService({ db, bus, work });
  // A Widget hears the answers to its Asks on its command stream.
  asks.setRecipient('widget', {
    reaches: (raiser) => raiser.kind === 'widget' && widgets.list().some((w) => w.id === raiser.widgetId && w.state === 'ready'),
    deliver: (ask) => {
      if (ask.raisedBy.kind === 'widget') widgets.sendCommand(ask.raisedBy.widgetId, { type: 'ask.answered', ask });
    },
  });
  // Stages a person moved to another model (a Fable reserve Ask's fallback).
  const stageModels = createStageModels(db);
  const pullRequests = createPullRequests({ db, bus, bridge });
  const gates = createGates({ bus, work, asks, dataDir: options.dataDir, policy, audit, pullRequests });
  // The Knowledge store (ticket 10): the markdown folder Digests live in.
  const knowledge = createMovableKnowledgeStore({ root: knowledgeDir, rollupAt: options.digestRollupAt });
  const sessions = createSessionManager({
    db,
    bus,
    work,
    widgets,
    asks,
    gates,
    knowledge,
    policy,
    audit,
    dataDir: options.dataDir,
    startBlocked: () => restart.blocksSessions(),
    upNext: (projectId) => scheduler.state().queue.filter((e) => e.projectId === projectId).map((e) => e.itemId),
    stageModel: stageModels.get,
    // Read once the usage service below exists (only when a Session is planned or started).
    budgetOf: (model) => usage.budgets().find((b) => b.models.includes(model))?.id,
    kilnToolsUrl: () => `http://127.0.0.1:${port}${KILN_TOOLS_PATH}`,
  });
  const panels = createWidgetPanels({ bus, host: widgets, widgets: () => installs.list() });
  // Pools come from approved Widgets' Manifests and from Budget kinds (local: gpu); the smaller size holds.
  const grantedPools = () => {
    const pools = { ...installs.grantedPools() };
    for (const [name, size] of Object.entries(usage.pools())) pools[name] = Math.min(size, pools[name] ?? size);
    return pools;
  };
  const scheduler = createScheduler({ db, bus, work, sessions, grantedPools });
  // Roll-up (ticket 08): a Story ships with its Tickets, an Epic with its Stories.
  createRollUp({ bus, work, scheduler });
  // A Project Thread Session's accepted proposal is applied as the person who accepted it (ticket 13).
  asks.setProposalApplier(createProposalApplier({ work, scheduler, audit }));
  // Budgets: every turn is recorded and its caps checked; a reached Project or Budget cap holds starts.
  const clock = createClock();
  const usage = createUsageService({ db, bus, work, sessions, asks, clock, poke: () => scheduler.poke(),
    poolSize: (name) => scheduler.state().pools.find((p) => p.name === name)?.size ?? 0,
  });
  scheduler.addGuard(usage.startHold);
  usage.setEnqueue((itemId) => scheduler.enqueue(itemId));
  scheduler.addPoolClaim(usage.poolsFor);
  // Runaway guards for every Budget kind: the stall rule and the context alarm.
  const runaway = createRunawayGuard({ db, bus, work, sessions, asks, enqueue: (itemId) => scheduler.enqueue(itemId) });
  const restart = createRestartWhenIdle({
    bus,
    runningSessions: () => sessions.running().length,
    restart: () => (options.onRestartRequested ?? options.onStopRequested)?.(),
  });
  // A Widget is identified by its credential, so its calls are audited as the Widget. It has no role:
  // beyond the /api/widget/ routes (see access.ts) it reaches only what its grants cover.
  access.addAuthenticator((req) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) return undefined;
    try {
      const id = widgets.authenticate(req.headers.authorization);
      return { actor: { kind: 'widget', id }, role: null, authorize: (method, url) => installs.allows(id, method, url) };
    } catch {
      return undefined;
    }
  });
  // A Session is identified by its Kiln tools credential and audited as itself. Like a Widget, it
  // has no role: it reaches only the Kiln tools route, which acts on its own Item.
  access.addAuthenticator((req) => {
    const token = bearer(req);
    const found = token ? sessions.kilnTools(token) : undefined;
    return found ? { actor: { kind: 'session', id: found.session.id, agent: found.session.agentId }, role: null } : undefined;
  });
  // `kiln doctor`'s core-side checks (GET /api/doctor). A later part registers its own check here;
  // the same id replaces a placeholder.
  const proxies = createProxyWatch({ port: () => port, login: loginMode });
  const doctor = createDoctor();
  doctor.register(widgetsCheck(() => installs.list()));
  doctor.register(agentsCheck(() => installs.list()));
  doctor.register(proxies.check);
  doctor.register({ id: 'knowledge-store', name: 'Knowledge store', run: () => knowledge.check() });
  doctor.register(usage.doctorCheck);
  // The setup wizard (ticket 25). The models it chooses for the default Workflow's roles are read
  // into every Project that uses that Workflow.
  const setup = createSetup({
    db,
    bus,
    work,
    budgets: () => usage.budgets(),
    widgets: () => installs.list(),
    servedByTailscale: () => proxies.servedByTailscale(),
    running: { login: loginMode, knowledgeDir: () => knowledge.root },
    moveKnowledge: (root) => knowledge.moveTo(root),
    assumeDone: options.testMode && process.env.KILN_TEST_SETUP_DONE === '1',
    devInstance: options.devInstance === true,
  });
  work.decorateWorkflow(setup.decorate);
  doctor.register(setup.doctorCheck);
  const shellDir = options.shellDir ?? DEFAULT_SHELL_DIR;
  const startedAt = new Date();
  const streams = new Set<ServerResponse>();

  const status = (): CoreStatus => ({
    name: 'Kiln',
    apiVersion: CORE_API_VERSION,
    pid: process.pid,
    port,
    dataDir: options.dataDir,
    startedAt: startedAt.toISOString(),
    uptimeMs: Date.now() - startedAt.getTime(),
    instance: options.devInstance ? 'dev' : 'live',
    ...(restart.pending() ? { restartPending: restart.pending() } : {}),
  });

  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as unknown) : null;
  };

  const writeEvent = (res: ServerResponse, event: KilnEvent, withId = true) => {
    const id = withId ? `id: ${event.id}\n` : '';
    res.write(`${id}data: ${JSON.stringify(event)}\n\n`);
  };

  const openStream = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    writeEvent(res, { id: 0, type: 'core.hello', at: new Date().toISOString(), payload: { startedAt: startedAt.toISOString() } }, false);
    const lastId = Number(req.headers['last-event-id'] ?? NaN);
    if (Number.isInteger(lastId)) for (const event of bus.since(lastId)) writeEvent(res, event);
    const snapshot = { projects: work.projects(), items: work.items() };
    writeEvent(res, { id: 0, type: 'work.snapshot', at: new Date().toISOString(), payload: snapshot }, false);
    writeEvent(res, { id: 0, type: 'asks.snapshot', at: new Date().toISOString(), payload: { asks: asks.list() } }, false);
    writeEvent(res, { id: 0, type: 'scheduler.updated', at: new Date().toISOString(), payload: scheduler.state() }, false);
    writeEvent(res, { id: 0, type: 'budgets.updated', at: new Date().toISOString(), payload: { budgets: usage.budgets() } }, false);
    const unsubscribe = bus.subscribe((event) => writeEvent(res, event));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    streams.add(res);
    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      streams.delete(res);
    });
  };

  const serveShell = async (path: string, res: ServerResponse) => {
    const relative = normalize(decodeURIComponent(path)).replace(/^[\\/]+/, '');
    const file = join(shellDir, relative);
    const inside = file.startsWith(shellDir.endsWith(sep) ? shellDir : shellDir + sep);
    const target = inside && extname(file) ? file : join(shellDir, 'index.html');
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: 'The Shell is not built. Run `npm run build`.' });
    }
  };

  const openCommandStream = (widgetId: string, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const detach = widgets.attachCommands(widgetId, (command) => res.write(`data: ${JSON.stringify(command)}\n\n`));
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    streams.add(res);
    res.on('close', () => {
      detach();
      clearInterval(heartbeat);
      streams.delete(res);
    });
  };

  const panelDeps = { access, widgetId: (req: IncomingMessage) => widgets.authenticate(req.headers.authorization), sendJson, readJson };

  /** A Widget's event subscription: only the types (and Projects) its grants allow. */
  const openWidgetEventStream = (widgetId: string, req: IncomingMessage, res: ServerResponse, url: URL) => {
    const types = (url.searchParams.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (types.length === 0) throw new WidgetHostError(400, 'Name the event types to follow: ?types=item.stage_changed,session.*');
    const { refused, accepts } = installs.subscription(widgetId, types);
    access.note(req, { detail: { types } });
    if (refused.length) throw new WidgetHostError(403, `This Widget's grants don't allow events: ${refused.join(', ')}`, 'grant');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    const lastId = Number(req.headers['last-event-id'] ?? NaN);
    if (Number.isInteger(lastId)) for (const event of bus.since(lastId)) if (accepts(event)) writeEvent(res, event);
    const unsubscribe = bus.subscribe((event) => {
      if (accepts(event)) writeEvent(res, event);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
    streams.add(res);
    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      streams.delete(res);
    });
  };

  /** Routes a Widget calls with its own credential. */
  const widgetRoute = async (route: string, req: IncomingMessage, res: ServerResponse, url: URL) => {
    const widgetId = widgets.authenticate(req.headers.authorization);
    if (route === 'GET /api/widget/commands') return openCommandStream(widgetId, res);
    if (route === 'GET /api/widget/events') return openWidgetEventStream(widgetId, req, res, url);
    if (route === 'POST /api/widget/register') {
      widgets.register(widgetId, ((await readJson(req)) ?? {}) as RegisterRequest);
      return sendJson(res, 200, { widgetId });
    }
    if (route === 'POST /api/widget/ready') {
      widgets.ready(widgetId);
      return sendJson(res, 200, { widgetId });
    }
    if (route === 'POST /api/widget/agent-events') {
      const report = (await readJson(req)) as AgentEventReport;
      access.note(req, { action: 'agent.event', target: `session:${String(report?.sessionId)}` });
      widgets.reportAgentEvent(widgetId, report);
      return sendJson(res, 202, { accepted: true });
    }
    if (route === 'POST /api/widget/asks') {
      // Only a Widget whose approved grants include `asks` may raise them.
      access.note(req, { action: 'ask.raise' });
      if (!installs.mayRaiseAsks(widgetId)) throw new WidgetHostError(403, "This Widget's grants don't include raising Asks", 'grant');
      const body = ((await readJson(req)) ?? {}) as Partial<WidgetRaiseAskRequest>;
      try {
        const ask = asks.raise({ ...(body as WidgetRaiseAskRequest), itemId: String(body.itemId ?? ''), raisedBy: { kind: 'widget', widgetId } });
        access.note(req, { action: 'ask.raise', target: `ask:${ask.id}` });
        return sendJson(res, 201, ask);
      } catch (err) {
        if (err instanceof WorkError) return sendJson(res, err.status, { error: err.message });
        throw err;
      }
    }
    if (route === 'POST /api/widget/replies') {
      bridge.reply(widgetId, ((await readJson(req)) ?? {}) as WidgetReply);
      return sendJson(res, 200, { accepted: true });
    }
    if (route === 'POST /api/widget/trackers/changed') {
      const { projectId } = ((await readJson(req)) ?? {}) as Partial<TrackerChangedRequest>;
      const project = work.projects().find((p) => p.id === projectId);
      if (!project || bridge.provider('trackers', project.tracker) !== widgetId) {
        throw new WidgetHostError(404, "No Project of this Widget's Tracker has that id");
      }
      bridge.changed(widgetId, project.id);
      return sendJson(res, 202, { accepted: true });
    }
    if (route === 'GET /api/widget/pull-requests') return sendJson(res, 200, pullRequests.openBy(widgetId));
    if (route === 'POST /api/widget/pull-requests/merged' || route === 'POST /api/widget/pull-requests/closed') {
      const merged = route.endsWith('/merged');
      const { projectId, number } = ((await readJson(req)) ?? {}) as Partial<PullRequestMergedRequest>;
      access.note(req, { action: merged ? 'pr.merged' : 'pr.closed', target: `project:${String(projectId)}` });
      await pullRequests[merged ? 'merged' : 'closed'](widgetId, String(projectId ?? ''), Number(number));
      return sendJson(res, 200, { accepted: true });
    }
    return sendJson(res, 404, { error: `No route for ${route}` });
  };

  /** The Kiln tools (MCP over Streamable HTTP), called by a Session with its own credential. */
  const kilnToolsRoute = async (req: IncomingMessage, res: ServerResponse) => {
    const token = bearer(req);
    const found = token ? sessions.kilnTools(token) : undefined;
    if (!found) return sendJson(res, 401, { error: 'The Kiln tools need the credential of a running Session' });
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }
    const message = await readJson(req);
    const tool = calledTool(message);
    access.note(req, { action: tool ? `kiln_tools.${tool}` : 'kiln_tools.call', target: kilnToolsTarget(found.session) });
    const answer = await answerKilnTools(found.scope, message);
    if (answer === undefined) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(res, 200, answer);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      proxies.observe(req);
      // Every /api/ route is behind the access gate: identity, role, CSRF and audit (see access.ts).
      if (url.pathname.startsWith('/api/') && !(await access.admit(req, res))) return;
      if (await handleIdentityRoute(req, res, url, { access, audit, users, login, sendJson, readJson })) return;
      if (route === 'GET /api/status') return sendJson(res, 200, status());
      if (route === 'GET /api/doctor') return sendJson(res, 200, await doctor.run());
      if (route === 'GET /api/events') return openStream(req, res);
      if (route === 'POST /api/core/stop') {
        // Stop once the reply (and its audit entry) is out.
        res.once('finish', () => options.onStopRequested?.());
        sendJson(res, 202, { stopping: true });
        return;
      }
      // Restart when idle: a person's action. Admin only, and no Widget grant ever covers it.
      if (route === 'POST /api/core/restart-when-idle') return sendJson(res, 202, restart.request());
      if (route === 'DELETE /api/core/restart-when-idle') {
        return restart.cancel() ? sendJson(res, 200, { cancelled: true }) : sendJson(res, 409, { error: 'No restart is pending' });
      }
      if (route === 'POST /api/test/echo' && options.testMode) {
        return sendJson(res, 200, bus.publish('test.echo', await readJson(req)));
      }
      if (url.pathname === KILN_TOOLS_PATH) return await kilnToolsRoute(req, res);
      if (await handleAskRoute(asks, access, req, res, url, { sendJson, readJson })) return;
      if (await handlePolicyRoute(policy, work, access, req, res, url, { sendJson, readJson })) return;
      if (await handleSchedulerRoute(scheduler, req, res, url, { sendJson, readJson })) return;
      if (await handleSetupRoute(setup, req, res, url, { sendJson, readJson })) return;
      if (await handleRunawayRoute(runaway, req, res, url, { sendJson, readJson })) return;
      if (await handleBudgetRoute(usage, clock, options.testMode === true, req, res, url, { sendJson, readJson })) return;
      if (await handleFlowRoute(sessions, scheduler, req, res, url, { sendJson, readJson })) return;
      if (await handleWorkRoute(work, req, res, url, { sendJson, readJson })) return;
      if (await handleSecretRoute(secrets, req, res, url, panelDeps)) return;
      if (await handlePanelRoute(panels, req, res, url, panelDeps)) return;
      if (url.pathname.startsWith('/api/widget/')) return await widgetRoute(route, req, res, url);
      if (await handleWidgetRoute(installs, req, res, url, { access, sendJson, readJson })) return;
      const testCommand = /^\/api\/test\/widgets\/([^/]+)\/commands$/.exec(url.pathname);
      if (testCommand && req.method === 'POST' && options.testMode) {
        widgets.sendCommand(decodeURIComponent(testCommand[1]!), (await readJson(req)) as WidgetCommand);
        return sendJson(res, 202, { sent: true });
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: `No route for ${route}` });
      if (req.method === 'GET') return await serveShell(url.pathname, res);
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (err) {
      if (err instanceof WidgetHostError && !res.headersSent) {
        if (err.reason) access.note(req, { refused: { reason: err.reason } });
        return sendJson(res, err.status, { error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
      }
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.end();
    }
  };

  const listen = (server: Server, listenPort: number, host: string) =>
    new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(listenPort, host, () => resolveListen());
    });

  // Local mode serves 127.0.0.1 only. Tailscale mode also serves the Tailscale addresses, on the same port.
  const servers = [createServer(handle)];
  await listen(servers[0]!, options.port, '127.0.0.1');
  port = (servers[0]!.address() as AddressInfo).port;
  for (const address of await login.bindAddresses()) {
    const server = createServer(handle);
    await listen(server, port, address);
    servers.push(server);
  }
  installs.resume();

  return {
    status,
    async stop() {
      restart.close();
      usage.close();
      runaway.close();
      await scheduler.close();
      installs.close();
      await widgets.stopAll();
      await sessions.idle();
      for (const res of streams) res.end();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
        ),
      );
      work.close();
      db.close();
    },
  };
}
