import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_FILE,
  readSse,
  type Manifest,
  type AgentCommand,
  type AgentMessage,
  type AgentModel,
  type KilnEvent,
  type SessionStart,
  type WidgetInfo,
} from '@kiln/widget-sdk';
import type { FakeAgentConfig, FakeAgentScripts, FakeAgentSettings } from './fake-agent/script.ts';
import { assertIsolated } from './isolation.ts';

const FAKE_AGENT_DIR = fileURLToPath(new URL('./fake-agent/', import.meta.url));
const TEST_WIDGET_DIR = fileURLToPath(new URL('./test-widget/', import.meta.url));

const CORE_MAIN = fileURLToPath(new URL('../../core/src/main.ts', import.meta.url));
const READY_TIMEOUT_MS = 15_000;
const DEFAULT_EVENT_TIMEOUT_MS = 5_000;

/** Anything with node:test's `t.after`, so cleanup is registered on the test that started it. */
export interface Cleanup {
  after(fn: () => unknown): void;
}

/** How long one harness cleanup may take before it fails the test. */
const CLEANUP_TIMEOUT_MS = 30_000;

interface CleanupStep {
  what: string;
  run: () => unknown;
  timeoutMs: number;
}

const cleanupSteps = new WeakMap<Cleanup, CleanupStep[]>();

/**
 * Runs `run` when the test ends, with the harness's own cleanups (core, temp folders, browser).
 * They all run in one `t.after` hook, in the order registered, and each one runs even when an
 * earlier one failed: node:test skips every later `after` hook once one throws, and a skipped
 * browser close leaves Chromium holding the test process open forever. A step that takes longer
 * than `timeoutMs` (default 30 s) fails the test with its name. Failures are reported together
 * once every step has had its turn.
 */
export function onCleanup(t: Cleanup, what: string, run: () => unknown, options?: { timeoutMs?: number }): void {
  let steps = cleanupSteps.get(t);
  if (!steps) {
    const registered: CleanupStep[] = [];
    cleanupSteps.set(t, registered);
    t.after(() => runCleanups(registered));
    steps = registered;
  }
  steps.push({ what, run, timeoutMs: options?.timeoutMs ?? CLEANUP_TIMEOUT_MS });
}

async function runCleanups(steps: CleanupStep[]): Promise<void> {
  const errors: Error[] = [];
  // A step may register another (e.g. a temp folder made while stopping), so read until empty.
  for (let step = steps.shift(); step; step = steps.shift()) {
    const { what, run, timeoutMs } = step;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Cleanup "${what}" did not finish within ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(run), timedOut]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error.message.startsWith('Cleanup "') ? error : new Error(`Cleanup "${what}" failed: ${error.message}`, { cause: error }));
    } finally {
      clearTimeout(timer);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map((e) => e.message).join('\n'));
}

export interface EventStream {
  /** Resolves with the next event of this type (received since the stream opened), or rejects on timeout. */
  next<E extends KilnEvent = KilnEvent>(type: E['type'], options?: { timeoutMs?: number }): Promise<E>;
  close(): void;
}

export interface TempRepo {
  path: string;
  /** Runs git in the repo and returns stdout. */
  git(...args: string[]): string;
}

/** In test mode, Tailscale mode treats a request with this header as that tailnet user (see core login.ts). */
export const TEST_PEER_HEADER = 'x-kiln-test-peer';

export interface TestKilnOptions {
  /** The login mode. Defaults to `local`, where every call from the harness is the local Admin. */
  login?: 'local' | 'tailscale';
  /** The core's first wait before restarting a crashed Widget (doubling per crash). Default 50 ms. */
  widgetRestartMs?: number;
  /**
   * Extra environment for the core process. By default `KILN_TAILSCALE_CLI` names a command that
   * doesn't exist, so no test asks this PC's real Tailscale anything; set it to a fake to test that.
   */
  env?: Record<string, string>;
  /**
   * `done` (default): the core starts as if setup had been finished, so the Shell opens on the
   * board. `fresh`: a data folder that has never been set up, so the Shell opens the setup wizard.
   */
  setup?: 'done' | 'fresh';
  /** Starts the core as a dev instance (`--dev-instance`, as `kiln dev` does): `GET /api/status` reports `instance: 'dev'`. */
  devInstance?: boolean;
}

/** The default `KILN_TAILSCALE_CLI` in tests: a command that is never installed. */
const NO_TAILSCALE = 'kiln-test-no-tailscale';
/** The default `KILN_HUGGINGFACE_URL` in tests: a closed local port, so no test reaches huggingface.co. */
const NO_HUGGING_FACE = 'http://127.0.0.1:9';
/** Setup's machine checks in tests: no old board, no Obsidian and no local model server, unless a test sets one. */
const NO_SUCH_FILE = join(tmpdir(), 'kiln-test-nothing-here', 'none');

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

/** Calls the core API as one caller. */
export interface ApiClient {
  /** Calls the core API and returns the parsed JSON body. Throws on a non-2xx status. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Calls the core API and returns the status and parsed body, whatever the status. */
  request<T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
}

export interface TestKiln extends ApiClient {
  url: string;
  port: number;
  dataDir: string;
  login: 'local' | 'tailscale';
  /** A temp git repo with one commit on `main`, ready to register as a Project. */
  repo: TempRepo;
  /**
   * A client that calls as this tailnet user (Tailscale mode only). Without `as`, calls come
   * from the person at the PC, who is Admin. Calls are non-browser, so they need no CSRF token.
   */
  as(userId: string): ApiClient;
  /**
   * Opens the SSE event stream. Closed automatically at the end of the test.
   * With `lastEventId`, the core first replays every stored event after that id.
   */
  events(options?: { lastEventId?: number }): Promise<EventStream>;
  /**
   * Starts the scripted fake Agent Widget in this core and waits until it is ready.
   * Every Session it starts runs `script`, or its role's script (default: finish at once).
   * `cacheLifetimeMs` is what it registers as its cache lifetime (default 300000), and `model` its
   * model (default `fake-model`; null: none). `models` are the model ids it lists as runnable.
   */
  installFakeAgent(options?: { script?: FakeAgentScripts; cacheLifetimeMs?: number; model?: string | null; models?: string[] }): Promise<FakeAgent>;
  /**
   * Unregisters a Project (`work.unregister`) through a test-only core route: the core has no
   * general route for it (the demo is its only caller).
   */
  unregisterProject(projectId: string): Promise<void>;
  /** Stops the core process (also done automatically at the end of the test). */
  stop(): Promise<void>;
}

/** A fake Agent Widget running in a test core. */
export interface FakeAgent {
  widgetId: string;
  /** The Agent id to name in `agent.start_session`. */
  agentId: string;
  /** Replaces the script; Sessions started from now on run it. */
  setScript(script: FakeAgentScripts): void;
  /** Sends an Agent command to the Widget (through a test-only core route). */
  command(command: AgentCommand): Promise<void>;
  /** Starts a Session (role "test", worktree the test repo, unless given) and returns its id. */
  startSession(start?: Partial<SessionStart>): Promise<string>;
  sendMessage(sessionId: string, message: AgentMessage): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  /** Stops the Widget process; the core keeps running. */
  stopWidget(): Promise<WidgetInfo>;
}

// The promise form: on Node 24, `rmSync` ignores `maxRetries` and fails at once with EPERM while
// another process (a git or Widget process exiting with the core) still has the folder open.
const removeDir = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const makeTempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  assertIsolated({ paths: [dir] });
  return dir;
};

/** Makes a throwaway folder in the OS temp dir, removed at the end of the test. */
export function tempDir(t: Cleanup, prefix: string): string {
  const dir = makeTempDir(prefix);
  onCleanup(t, `remove ${dir}`, () => removeDir(dir));
  return dir;
}

/** Creates a temp git repo with one commit on `main`, removed at the end of the test. */
export function createTempRepo(t: Cleanup): TempRepo {
  return initRepo(tempDir(t, 'kiln-repo'));
}

/** A throwaway Widget source holding the test Widget (`packages/testing/src/test-widget`). */
export interface WidgetSource {
  /** Pass as `source` to `POST /api/widgets`. */
  path: string;
  manifest: Manifest;
  /** Rewrites `kiln-widget.json` with these fields changed (and commits, in a git source). */
  setManifest(change: Partial<Manifest>): void;
  /** The current commit (git sources only). */
  head(): string;
  /** Runs git in the source (git sources only). */
  git(...args: string[]): string;
}

export interface WidgetSourceOptions {
  /** A git repo (default) or a plain local folder. */
  git?: boolean;
  manifest?: Partial<Manifest>;
  /** Extra files to put in the source, by relative path (e.g. an embedded page). */
  files?: Record<string, string>;
}

/** Drives the test Widget (`packages/testing/src/test-widget`) running in a test core. */
export interface TestWidgetDriver {
  /** Makes the Widget call the core with its own credential; resolves with what the core answered. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  /** Makes the Widget subscribe to core events; resolves with the status (and body when refused). */
  subscribe(types: string[], options?: { lastEventId?: number }): Promise<ApiResponse>;
  /** Every event the Widget has received through its subscriptions so far. */
  received(): KilnEvent[];
  /** Waits until the Widget has received an event matching `match`. */
  nextReceived(match: (event: KilnEvent) => boolean, options?: { timeoutMs?: number }): Promise<KilnEvent>;
  /** Waits until the Widget has been sent `count` actions, and returns them all. */
  actions(count: number, options?: { timeoutMs?: number }): Promise<Record<string, unknown>[]>;
  /** The names of the environment variables the Widget process was started with, sorted. */
  envNames(): Promise<string[]>;
}

const readLines = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

async function waitFor<T>(what: string, timeoutMs: number, check: () => T | undefined): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) {
    const found = check();
    if (found !== undefined) return found;
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}

/** A driver for the test Widget installed as `widgetId` in this core (it must be running). */
export function driveTestWidget(kiln: TestKiln, widgetId = 'test-widget'): TestWidgetDriver {
  const data = join(kiln.dataDir, 'widgets', widgetId, 'data');
  const file = (name: string) => join(data, name);
  const send = (command: unknown) => kiln.api('POST', `/api/test/widgets/${widgetId}/commands`, command);
  const nextLine = async (name: string, command: unknown) => {
    const before = readLines(file(name)).length;
    await send(command);
    return waitFor(`the Widget's ${name} entry`, DEFAULT_EVENT_TIMEOUT_MS, () => readLines(file(name))[before]);
  };
  return {
    async call<T>(method: string, path: string, body?: unknown) {
      const line = await nextLine('calls.jsonl', { type: 'test.call', method, path, body });
      return { status: line.status as number, body: line.body as T };
    },
    async subscribe(types, options) {
      const line = await nextLine('subscriptions.jsonl', { type: 'test.subscribe', types, ...options });
      return { status: line.status as number, body: line.body };
    },
    received: () => readLines(file('events.jsonl')) as unknown as KilnEvent[],
    nextReceived: (match, options) =>
      waitFor('an event at the Widget', options?.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS, () =>
        (readLines(file('events.jsonl')) as unknown as KilnEvent[]).find(match),
      ),
    actions: (count, options) =>
      waitFor(`${count} actions at the Widget`, options?.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS, () => {
        const lines = readLines(file('actions.jsonl'));
        return lines.length >= count ? lines : undefined;
      }),
    async envNames() {
      return (await nextLine('env.jsonl', { type: 'test.env' })).names as string[];
    },
  };
}

/** Creates a local Widget source for install tests, so no test ever needs the network. */
export function createWidgetSource(t: Cleanup, options: WidgetSourceOptions = {}): WidgetSource {
  const path = tempDir(t, 'kiln-widget-source');
  const useGit = options.git ?? true;
  let manifest: Manifest = {
    id: 'test-widget',
    name: 'Test Widget',
    version: '1.0.0',
    coreApi: '^0.1.0',
    command: ['node', 'main.mjs'],
    ...options.manifest,
    // The test Widget logs what it did into its data folder, so it asks for one unless told not to.
    needs: { dataFolder: true, ...options.manifest?.needs },
  };
  copyFileSync(join(TEST_WIDGET_DIR, 'main.mjs'), join(path, 'main.mjs'));
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(path, relative)), { recursive: true });
    writeFileSync(join(path, relative), content);
  }
  const write = () => writeFileSync(join(path, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  write();
  const repo = useGit ? initRepo(path) : undefined;
  const git = (...args: string[]) => {
    if (!repo) throw new Error('Not a git Widget source');
    return repo.git(...args);
  };
  return {
    path,
    get manifest() {
      return manifest;
    },
    setManifest(change) {
      manifest = { ...manifest, ...change, ...(change.needs ? { needs: { dataFolder: true, ...change.needs } } : {}) };
      write();
      if (repo) {
        repo.git('add', '.');
        repo.git('commit', '-q', '-m', `Manifest ${manifest.version}`);
      }
    },
    head: () => git('rev-parse', 'HEAD').trim(),
    git,
  };
}

/** An Agent Widget in a fake Widget repo: the test Widget, registering one Agent. */
export interface FakeAgentWidget {
  /** The Widget id, and its folder `widgets/<id>` in the repo. */
  id: string;
  name: string;
  agent: { id: string; name: string; model?: string; models?: AgentModel[] };
}

/**
 * A stand-in for the public Widget repo: a temp git repo with the first-party Agent Widgets'
 * folders (today only `widgets/claude-code`), each the test Widget registering one Agent.
 */
export function createFakeWidgetRepo(t: Cleanup, widgets?: FakeAgentWidget[]): TempRepo {
  const repo = initRepo(tempDir(t, 'kiln-widget-repo'));
  for (const widget of widgets ?? [
    { id: 'claude-code', name: 'Claude Code', agent: { id: 'claude', name: 'Claude Code', model: 'claude-test-model', models: [{ id: 'claude-test-model', name: 'Claude Test' }] } },
  ]) {
    const folder = join(repo.path, 'widgets', widget.id);
    mkdirSync(folder, { recursive: true });
    copyFileSync(join(TEST_WIDGET_DIR, 'main.mjs'), join(folder, 'main.mjs'));
    writeFileSync(join(folder, 'agents.json'), JSON.stringify([widget.agent]));
    const manifest: Manifest = {
      id: widget.id,
      name: widget.name,
      version: '1.0.0',
      coreApi: '^0.1.0',
      command: ['node', 'main.mjs'],
      provides: { agents: [{ id: widget.agent.id, name: widget.agent.name }] },
      needs: { dataFolder: true },
    };
    writeFileSync(join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'Agent Widgets');
  return repo;
}

/** This checkout's root. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The first-party Agent Widgets, as the Widget repo holds them. */
export const FIRST_PARTY_AGENT_WIDGETS = ['claude-code'];

/**
 * A stand-in for a clone of this repo: a temp git repo holding this checkout's `widgets/<id>`
 * folders as they are now (without node_modules), so a test installs the real Widgets the way Kiln
 * installs them from the public repo. Install with `npm_config_offline=true` in the core's env so
 * their packages come from npm's cache, never the network.
 */
export function createWidgetRepoCopy(t: Cleanup, widgetIds: string[] = FIRST_PARTY_AGENT_WIDGETS): TempRepo {
  const repo = initRepo(tempDir(t, 'kiln-widget-repo-copy'));
  for (const id of widgetIds) {
    cpSync(join(REPO_ROOT, 'widgets', id), join(repo.path, 'widgets', id), {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
    });
  }
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'First-party Widgets');
  return repo;
}

function initRepo(path: string): TempRepo {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Kiln Test', '-c', 'user.email=test@kiln.invalid', '-c', 'core.autocrlf=false', ...args],
      { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init', '-q', '-b', 'main');
  // A real Agent commits with plain `git commit` in its worktree, which shares this config; the
  // machine may have no global identity.
  git('config', 'user.name', 'Kiln Test');
  git('config', 'user.email', 'test@kiln.invalid');
  // The machine's global hooks (a global core.hooksPath) stay out of test repos: tests commit what Kiln
  // must refuse, such as a Co-Authored-By trailer, and a test runs the same on every machine.
  git('config', 'core.hooksPath', join(path, '.git', 'hooks'));
  writeFileSync(join(path, 'README.md'), '# Test Project\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Initial commit');
  return { path, git };
}

async function openEventStream(url: string, lastEventId?: number): Promise<EventStream> {
  const controller = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const res = await fetch(`${url}/api/events`, { signal: controller.signal, headers });
  if (!res.ok || !res.body) throw new Error(`Event stream failed: ${res.status}`);
  const received: KilnEvent[] = [];
  const waiters = new Set<() => void>();

  void readSse(res.body, (data) => {
    received.push(JSON.parse(data) as KilnEvent);
    for (const wake of waiters) wake();
  });

  return {
    next(type, options) {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
      return new Promise((resolveNext, rejectNext) => {
        const check = () => {
          const i = received.findIndex((event) => event.type === type);
          if (i === -1) return false;
          const [event] = received.splice(i, 1);
          waiters.delete(check);
          clearTimeout(timer);
          resolveNext(event as never);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          rejectNext(new Error(`No "${type}" event within ${timeoutMs}ms`));
        }, timeoutMs);
        if (!check()) waiters.add(check);
      });
    },
    close: () => controller.abort(),
  };
}

function waitForReady(child: ChildProcess, stderr: () => string): Promise<{ port: number }> {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Core not ready within ${READY_TIMEOUT_MS}ms\n${stderr()}`)), READY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as { kiln?: string; port?: number };
        if (message.kiln === 'ready' && message.port) {
          clearTimeout(timer);
          resolveReady({ port: message.port });
        }
      } catch {
        // Not a protocol line.
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Core exited with code ${code} before it was ready\n${stderr()}`));
    });
  });
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid in `<dataDir>/core.json`, if a core wrote one. */
const runtimePid = (dataDir: string): number | undefined => {
  try {
    return (JSON.parse(readFileSync(join(dataDir, 'core.json'), 'utf8')) as { pid?: number }).pid;
  } catch {
    return undefined;
  }
};

/** Stops a core that replaced the test's own process in this data folder (Restart when idle). */
async function stopReplacement(dataDir: string, originalPid: number | undefined, url: string): Promise<void> {
  // The old process exits only after its replacement has written core.json, so this is current.
  const pid = runtimePid(dataDir);
  if (pid === undefined || pid === originalPid || !isAlive(pid)) return;
  await fetch(`${url}/api/core/stop`, { method: 'POST' }).catch(() => undefined);
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  if (isAlive(pid)) process.kill(pid);
}

/**
 * Starts a real core process for one test: a free port, a throwaway data folder,
 * test mode on, and a temp git repo. Everything is torn down when the test ends.
 */
export async function startTestKiln(t: Cleanup, options: TestKilnOptions = {}): Promise<TestKiln> {
  const login = options.login ?? 'local';
  const dataDir = makeTempDir('kiln-data');
  const repoDir = makeTempDir('kiln-repo');
  // Registered in this order, so the core is always stopped before its folders are removed
  // (Windows holds file locks).
  let stop: () => Promise<void> = async () => undefined;
  onCleanup(t, 'stop the core', () => stop());
  onCleanup(t, `remove ${dataDir}`, () => removeDir(dataDir));
  onCleanup(t, `remove ${repoDir}`, () => removeDir(repoDir));
  const repo = initRepo(repoDir);
  const restartMs = String(options.widgetRestartMs ?? 50);
  const args = [CORE_MAIN, '--port', '0', '--data-dir', dataDir, '--login', login, '--test-mode', '--widget-restart-ms', restartMs];
  if (options.devInstance) args.push('--dev-instance');
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // The core is not a test file: with the runner's context, a `node --test` it runs (a
      // `tests_pass` Exit) would report to this runner and exit 0 even when its tests fail.
      NODE_TEST_CONTEXT: undefined,
      KILN_PORT: undefined,
      KILN_DATA_DIR: undefined,
      KILN_LOGIN: undefined,
      KILN_TAILSCALE_CLI: NO_TAILSCALE,
      KILN_OLD_BOARD_REGISTRY: NO_SUCH_FILE,
      KILN_OBSIDIAN_PATHS: NO_SUCH_FILE,
      KILN_LOCAL_MODEL_URLS: '',
      KILN_HUGGINGFACE_URL: NO_HUGGING_FACE,
      ...(options.setup === 'fresh' ? {} : { KILN_TEST_SETUP_DONE: '1' }),
      ...options.env,
    },
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  stop = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  };
  const { port } = await waitForReady(child, () => stderr);
  assertIsolated({ port, paths: [dataDir, repo.path] });
  const url = `http://127.0.0.1:${port}`;
  const streams = new Set<EventStream>();

  let stopped: Promise<void> | undefined;
  stop = () =>
    (stopped ??= (async () => {
      for (const stream of streams) stream.close();
      if (child.exitCode === null) {
        await fetch(`${url}/api/core/stop`, { method: 'POST' }).catch(() => undefined);
        const killed = setTimeout(() => child.kill(), 5_000);
        await exited;
        clearTimeout(killed);
      }
      // After "Restart when idle" the core serving this test is a replacement process; stop it too.
      await stopReplacement(dataDir, child.pid, url);
    })());

  const client = (asUser?: string): ApiClient => {
    const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
      const all: Record<string, string> = { ...headers };
      if (body !== undefined) all['content-type'] = 'application/json';
      if (asUser !== undefined) all[TEST_PEER_HEADER] = asUser;
      const res = await fetch(`${url}${path}`, {
        method,
        headers: all,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
        void res.body?.cancel();
        return { res, text: '' };
      }
      return { res, text: await res.text() };
    };
    return {
      async api<T>(method: string, path: string, body?: unknown) {
        const { res, text } = await send(method, path, body);
        if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
        return (text ? JSON.parse(text) : undefined) as T;
      },
      async request<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
        const { res, text } = await send(method, path, body, headers);
        return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
      },
    };
  };

  const { api, request } = client();
  const as = (userId: string) => {
    if (login !== 'tailscale') throw new Error('kiln.as() needs startTestKiln(t, { login: "tailscale" })');
    return client(userId);
  };

  const events = async (options?: { lastEventId?: number }) => {
    const stream = await openEventStream(url, options?.lastEventId);
    streams.add(stream);
    return stream;
  };

  let fakeAgentScript: string | undefined;
  const installFakeAgent = async (options?: { script?: FakeAgentScripts; cacheLifetimeMs?: number; model?: string | null; models?: string[] }): Promise<FakeAgent> => {
    // One script file per core: the install's config names it, and a restart keeps that config.
    fakeAgentScript ??= join(tempDir(t, 'kiln-fake-agent'), 'script.json');
    const scriptFile = fakeAgentScript;
    const setScript = (script: FakeAgentScripts) => writeFileSync(scriptFile, JSON.stringify(script));
    setScript(options?.script ?? [{ do: 'finish' }]);
    const settings: FakeAgentSettings = {
      ...(options?.cacheLifetimeMs === undefined ? {} : { cacheLifetimeMs: options.cacheLifetimeMs }),
      ...(options?.model === undefined ? {} : { model: options.model }),
      ...(options?.models === undefined ? {} : { models: options.models }),
    };
    writeFileSync(join(dirname(scriptFile), 'agent.json'), JSON.stringify(settings));
    const config: FakeAgentConfig = { scriptFile };
    const stream = await events();
    // Installed from its folder in this repo (pinned by hash), approved as the local Admin, then
    // started. A second call in the same core just starts it again.
    const widgetId = 'fake-agent';
    const installed = (await api<WidgetInfo[]>('GET', '/api/widgets')).some((w) => w.id === widgetId);
    if (installed) await api<WidgetInfo>('POST', `/api/widgets/${widgetId}/start`);
    else {
      await api<WidgetInfo>('POST', '/api/widgets', { source: FAKE_AGENT_DIR, config });
      await api<WidgetInfo>('POST', `/api/widgets/${widgetId}/approve`);
    }
    await stream.next('widget.ready', { timeoutMs: READY_TIMEOUT_MS });
    stream.close();
    let sessions = 0;
    const command = (body: AgentCommand) => api<void>('POST', `/api/test/widgets/${widgetId}/commands`, body);
    return {
      widgetId,
      agentId: 'fake',
      setScript,
      command,
      async startSession(start) {
        const session: SessionStart = { sessionId: `fake-session-${++sessions}`, role: 'test', prompt: '', worktree: repo.path, ...start };
        await command({ type: 'agent.start_session', agentId: 'fake', session });
        return session.sessionId;
      },
      sendMessage: (sessionId, message) => command({ type: 'agent.send_message', sessionId, message }),
      interrupt: (sessionId) => command({ type: 'agent.interrupt', sessionId }),
      resume: (sessionId) => command({ type: 'agent.resume', sessionId }),
      stopSession: (sessionId) => command({ type: 'agent.stop', sessionId }),
      stopWidget: () => api<WidgetInfo>('POST', `/api/widgets/${widgetId}/stop`),
    };
  };

  const unregisterProject = (projectId: string) =>
    api<void>('POST', `/api/test/projects/${encodeURIComponent(projectId)}/unregister`);

  return { url, port, dataDir, login, repo, api, request, as, events, installFakeAgent, unregisterProject, stop };
}
