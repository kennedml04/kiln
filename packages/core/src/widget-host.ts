import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MANIFEST_FILE,
  WIDGET_ENV,
  type AgentEventReport,
  type AgentRegistration,
  type Manifest,
  type RegisterRequest,
  type WidgetCommand,
  type WidgetState,
} from '@kiln/widget-sdk';
import type { EventBus } from './events.ts';

const STOP_GRACE_MS = 3_000;

/** A refused or invalid Widget request; `status` is the HTTP code to answer with. */
export class WidgetHostError extends Error {
  status: number;
  /** For a refusal (403): why, e.g. `source` or `grant`. It is sent back and audited. */
  reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    if (reason) this.reason = reason;
  }
}

/** The states of a Widget process. Installs, approval and restarts live in widgets/lifecycle.ts. */
export type ProcessState = Extract<WidgetState, 'starting' | 'registered' | 'ready' | 'stopping' | 'stopped'> | 'exited';

interface RunningWidget {
  manifest: Manifest;
  folder: string;
  token: Buffer;
  child: ChildProcess;
  exited: Promise<void>;
  state: ProcessState;
  readyAt: number | null;
  agents: AgentRegistration[];
  /** The open command stream, or commands waiting for one. */
  send: ((command: WidgetCommand) => void) | null;
  pending: WidgetCommand[];
}

/** What the host knows about one Widget's process. */
export interface WidgetProcess {
  state: ProcessState;
  pid: number | null;
  agents: AgentRegistration[];
}

/** How a Widget process ended. `asked` is true when Kiln stopped it. */
export interface WidgetExit {
  code: number | null;
  asked: boolean;
  /** How long it had been ready, or null if it never got there. */
  readyForMs: number | null;
}

export interface StartSpec {
  folder: string;
  manifest: Manifest;
  config: unknown;
  apiUrl: string;
}

export interface WidgetHost {
  /** The process of this Widget, if one was ever started in this core. */
  process(id: string): WidgetProcess | undefined;
  /** Every Widget process started in this core, with its Widget id. */
  list(): (WidgetProcess & { id: string })[];
  start(spec: StartSpec): WidgetProcess;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  /** Called after every Widget process exit, asked for or not. */
  onExit(listener: (id: string, exit: WidgetExit) => void): void;
  /** The id of the Widget holding this credential (an `authorization` header), or a 401. */
  authenticate(authorization: string | undefined): string;
  register(id: string, request: RegisterRequest): void;
  ready(id: string): void;
  /** Attaches a Widget's command stream; returns a detach function. */
  attachCommands(id: string, send: (command: WidgetCommand) => void): () => void;
  sendCommand(id: string, command: WidgetCommand): void;
  reportAgentEvent(id: string, report: AgentEventReport): void;
  /**
   * Hands Agent events to the Session manager first. When it returns true the event was for one of
   * its Sessions (it publishes `session.*`); otherwise the host publishes `agent.<kind>` itself.
   */
  routeAgentEvents(handler: (widgetId: string, report: AgentEventReport) => boolean): void;
}

/** Reads and checks the Manifest in a Widget folder. */
export function readManifest(folder: string): Manifest {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), 'utf8')) as Manifest;
  } catch (err) {
    throw new WidgetHostError(400, `No readable ${MANIFEST_FILE} in ${folder}: ${String(err)}`);
  }
  if (!manifest.id || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) throw new WidgetHostError(400, 'Manifest id must be lowercase letters, digits and dashes');
  if (!Array.isArray(manifest.command) || manifest.command.length === 0) throw new WidgetHostError(400, 'Manifest command is missing');
  if (typeof manifest.coreApi !== 'string' || !manifest.coreApi.trim()) throw new WidgetHostError(400, 'Manifest coreApi range is missing');
  return manifest;
}

/**
 * The variables of the core's environment a Widget process gets: what programs need to run (paths,
 * the user's profile folders, locale, proxy and certificate settings), never the core's tokens or
 * its own KILN_ settings. Names are matched without case (Windows has `Path`).
 */
const WIDGET_BASE_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'USER', 'LOGNAME', 'SHELL',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export function widgetBaseEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && WIDGET_BASE_ENV.has(name.toUpperCase())) kept[name] = value;
  return kept;
}

/** The Platform's Widget host: starts Widget processes, holds their credentials and relays their traffic. */
export function createWidgetHost(bus: EventBus, dataDir: string): WidgetHost {
  const widgets = new Map<string, RunningWidget>();
  const exitListeners: ((id: string, exit: WidgetExit) => void)[] = [];
  let agentEventHandler: ((widgetId: string, report: AgentEventReport) => boolean) | undefined;

  const info = (w: RunningWidget): WidgetProcess => ({
    state: w.state,
    pid: w.state === 'stopped' || w.state === 'exited' ? null : (w.child.pid ?? null),
    agents: w.agents,
  });

  const get = (id: string): RunningWidget => {
    const w = widgets.get(id);
    if (!w) throw new WidgetHostError(404, `No Widget "${id}"`);
    return w;
  };

  const live = (w: RunningWidget) => w.state !== 'stopped' && w.state !== 'exited';

  const stop = async (id: string): Promise<void> => {
    const w = widgets.get(id);
    if (!w || !live(w)) return;
    w.state = 'stopping';
    if (w.send) w.send({ type: 'widget.stop' });
    const killed = setTimeout(() => w.child.kill(), w.send ? STOP_GRACE_MS : 0);
    await w.exited;
    clearTimeout(killed);
  };

  return {
    process: (id) => {
      const w = widgets.get(id);
      return w ? info(w) : undefined;
    },

    list: () => [...widgets].map(([id, w]) => ({ id, ...info(w) })),

    onExit(listener) {
      exitListeners.push(listener);
    },

    start({ folder: folderPath, manifest, config, apiUrl }) {
      const folder = resolve(folderPath);
      const existing = widgets.get(manifest.id);
      if (existing && live(existing)) throw new WidgetHostError(409, `Widget "${manifest.id}" is already running`);
      const widgetDir = join(dataDir, 'widgets', manifest.id);
      mkdirSync(widgetDir, { recursive: true });
      // Only a Widget whose Manifest asks for a data folder gets one.
      const widgetData = manifest.needs?.dataFolder ? join(widgetDir, 'data') : undefined;
      if (widgetData) mkdirSync(widgetData, { recursive: true });
      const token = randomBytes(32);
      const [command, ...args] = manifest.command as [string, ...string[]];
      const child = spawn(command === 'node' ? process.execPath : command, args, {
        cwd: folder,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...widgetBaseEnv(process.env),
          [WIDGET_ENV.apiUrl]: apiUrl,
          [WIDGET_ENV.widgetId]: manifest.id,
          [WIDGET_ENV.token]: token.toString('base64url'),
          ...(widgetData ? { [WIDGET_ENV.dataDir]: widgetData } : {}),
          [WIDGET_ENV.config]: JSON.stringify(config ?? {}),
        },
      });
      const log = createWriteStream(join(widgetDir, 'widget.log'), { flags: 'a' });
      child.stdout!.pipe(log, { end: false });
      child.stderr!.pipe(log, { end: false });
      const w: RunningWidget = {
        manifest,
        folder,
        token,
        child,
        exited: new Promise((done) => {
          child.once('exit', (code) => {
            log.end();
            const asked = w.state === 'stopping';
            w.state = asked ? 'stopped' : 'exited';
            w.send = null;
            if (asked) bus.publish('widget.stopped', { widgetId: manifest.id });
            else bus.publish('widget.exited', { widgetId: manifest.id, code });
            const exit: WidgetExit = { code, asked, readyForMs: w.readyAt === null ? null : Date.now() - w.readyAt };
            for (const listener of exitListeners) listener(manifest.id, exit);
            done();
          });
        }),
        state: 'starting',
        readyAt: null,
        agents: [],
        send: null,
        pending: [],
      };
      child.once('error', (err) => {
        log.write(`spawn failed: ${String(err)}\n`);
        // A command that never started emits no 'exit'; treat it as a crash so restarts apply.
        if (child.pid === undefined) child.emit('exit', null, null);
      });
      widgets.set(manifest.id, w);
      bus.publish('widget.started', { widgetId: manifest.id, pid: child.pid ?? null });
      return info(w);
    },

    stop,

    async stopAll() {
      await Promise.all([...widgets.keys()].map((id) => stop(id)));
    },

    authenticate(authorization) {
      const presented = Buffer.from(/^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '', 'base64url');
      for (const [id, w] of widgets) {
        if (live(w) && presented.length === w.token.length && timingSafeEqual(presented, w.token)) return id;
      }
      throw new WidgetHostError(401, 'A valid Widget credential is required');
    },

    register(id, request) {
      const w = get(id);
      const declared = new Set((w.manifest.provides?.agents ?? []).map((a) => a.id));
      const agents = request.agents ?? [];
      const undeclared = agents.filter((a) => !declared.has(a.id));
      if (undeclared.length) throw new WidgetHostError(403, `Agents not in the Manifest: ${undeclared.map((a) => a.id).join(', ')}`);
      w.agents = agents;
      w.state = 'registered';
      bus.publish('widget.registered', { widgetId: id, name: w.manifest.name, version: w.manifest.version, agents });
    },

    ready(id) {
      const w = get(id);
      w.state = 'ready';
      w.readyAt = Date.now();
      bus.publish('widget.ready', { widgetId: id });
    },

    attachCommands(id, send) {
      const w = get(id);
      w.send = send;
      for (const command of w.pending.splice(0)) send(command);
      return () => {
        if (w.send === send) w.send = null;
      };
    },

    sendCommand(id, command) {
      const w = get(id);
      if (!live(w)) throw new WidgetHostError(409, `Widget "${id}" is not running`);
      if (w.send) w.send(command);
      else w.pending.push(command);
    },

    reportAgentEvent(id, report) {
      const w = get(id);
      if (w.agents.length === 0) throw new WidgetHostError(403, `Widget "${id}" registered no Agent`);
      if (agentEventHandler?.(id, report)) return;
      const { event, sessionId } = report;
      bus.publish(`agent.${event.kind}`, { ...event, widgetId: id, sessionId });
    },

    routeAgentEvents(handler) {
      agentEventHandler = handler;
    },
  };
}
