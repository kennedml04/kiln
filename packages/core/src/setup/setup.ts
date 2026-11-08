// The setup wizard's core half (ticket 25): the settings an Admin chooses on first run, what this
// machine has (Obsidian, a local model server, the old board), the default Budgets, and the one-time
// import of the old board's Projects. The Shell walks the steps; the core stores and checks them.
//
// The old board is only ever read: its registry is read with readFileSync and nothing is written in
// its folder. Its own folder is never imported as a Project (registering writes a Project Policy).
import type { DatabaseSync } from 'node:sqlite';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  LOCAL_DEFAULTS,
  METERED_DEFAULTS,
  OLD_BOARD_DATA_FOLDER,
  PUBLIC_WIDGET_REPO,
  SUBSCRIPTION_DEFAULTS,
  TAILSCALE_SERVE_NOTE,
  type BudgetDraft,
  type BudgetInfo,
  type DemoMode,
  type FirstPartyAgent,
  type ImportResult,
  type InstallKind,
  type LoginMode,
  type OldBoardProject,
  type RoleModel,
  type SetupSettings,
  type SetupState,
  type TailscaleServe,
  type WidgetInfo,
  type Workflow,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import type { DoctorCheck } from '../operations/doctor.ts';
import { DEFAULT_WORKFLOW } from '../work/default-workflow.ts';
import { toolsOf } from '../work/module-commands.ts';
import { DEFAULT_MODULE_REPO, loadModules } from '../work/modules.ts';
import type { Work } from '../work/work.ts';

export class SetupError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The first-party Agent Widgets, each a folder of the Widget repo. */
const FIRST_PARTY_AGENTS: Omit<FirstPartyAgent, 'installed'>[] = [
  { id: 'claude-code', name: 'Claude Code', path: 'widgets/claude-code', about: 'Runs Claude models (a Claude Max subscription or metered credits).', suggested: ['work', 'home'] },
];

const OBSIDIAN_SUGGESTION =
  'Obsidian is not installed. It is optional: Kiln writes plain markdown either way, but Obsidian makes the ' +
  'Knowledge store easy to browse and link. Get it from https://obsidian.md and open the Knowledge store folder as a vault.';

const DEV_IMPORT_REFUSED = "Dev instances don't import real Projects; add one by hand if you mean to";

const LOCAL_SERVER_URLS = ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.0.0.1:8080/v1'];
const PROBE_MS = 1_000;

const obsidianPaths = (env: NodeJS.ProcessEnv): string[] => {
  if (env.KILN_OBSIDIAN_PATHS !== undefined) return env.KILN_OBSIDIAN_PATHS.split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    return [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'),
      env.ProgramFiles && join(env.ProgramFiles, 'Obsidian', 'Obsidian.exe'),
    ].filter((p): p is string => Boolean(p));
  }
  if (process.platform === 'darwin') return ['/Applications/Obsidian.app', join(homedir(), 'Applications', 'Obsidian.app')];
  return ['/usr/bin/obsidian', '/usr/local/bin/obsidian', '/snap/bin/obsidian', '/opt/Obsidian/obsidian'];
};

const localServerUrls = (env: NodeJS.ProcessEnv): string[] =>
  env.KILN_LOCAL_MODEL_URLS !== undefined
    ? env.KILN_LOCAL_MODEL_URLS.split(',').map((u) => u.trim()).filter(Boolean)
    : LOCAL_SERVER_URLS;

/** The first OpenAI-compatible model server that answers `GET <base>/models`, and its models. */
async function findLocalModelServer(urls: string[]): Promise<SetupState['localModelServer']> {
  const probes = urls.map(async (url) => {
    const res = await fetch(`${url.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(PROBE_MS) });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return { found: true, url, models };
  });
  const found = await Promise.allSettled(probes);
  for (const result of found) if (result.status === 'fulfilled') return result.value;
  return { found: false, models: [] };
}

/** The Budgets each kind of install starts with. The limits are the kinds' defaults, and editable. */
export function defaultBudgets(local: SetupState['localModelServer']): Record<InstallKind, BudgetDraft[]> {
  return {
    work: [{ id: 'work-credits', kind: 'metered', name: 'Work credits', models: [], ...METERED_DEFAULTS }],
    home: [
      { id: 'claude-max', kind: 'subscription', name: 'Claude Max', models: [], ...SUBSCRIPTION_DEFAULTS },
      ...(local.found ? [{ id: 'local', kind: 'local' as const, name: 'Local models', models: local.models, ...LOCAL_DEFAULTS }] : []),
    ],
  };
}

/** The default Workflow's roles, each with the Stages that use it. */
const defaultRoles = (): SetupState['roles'] => {
  const roles = new Map<string, string[]>();
  for (const kind of DEFAULT_WORKFLOW.kinds) {
    for (const stage of kind.stages) {
      if (stage.role) roles.set(stage.role, [...(roles.get(stage.role) ?? []), `${kind.name}: ${stage.name}`]);
    }
  }
  // Kiln's own role, beside the Workflow's: Scratch chats run on `chat`.
  if (!roles.has('chat')) roles.set('chat', ['Scratch chat']);
  return [...roles].map(([role, stages]) => ({ role, stages }));
};

const inside = (parent: string, child: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The old board's folder: its registry sits in its data folder (OLD_BOARD_DATA_FOLDER), one level down. */
const oldBoardFolder = (registry: string) => {
  const data = dirname(registry);
  return basename(data).toLowerCase() === OLD_BOARD_DATA_FOLDER ? dirname(data) : data;
};

interface RegistryEntry {
  name?: unknown;
  path?: unknown;
}

const readRegistry = (registry: string): RegistryEntry[] => {
  // Read-only: the old board must keep running untouched.
  const parsed = JSON.parse(readFileSync(registry, 'utf8')) as { projects?: unknown } | unknown[];
  const list = Array.isArray(parsed) ? parsed : (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(list)) throw new Error('it lists no "projects"');
  return list as RegistryEntry[];
};

export interface SetupDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  budgets(): BudgetInfo[];
  widgets(): WidgetInfo[];
  /** What `tailscale serve` forwards to Kiln, if anything. */
  servedByTailscale(): Promise<TailscaleServe | undefined>;
  running: { login: LoginMode; knowledgeDir(): string };
  /** Points the Knowledge store at a new folder, at once. */
  moveKnowledge(root: string): void;
  /** Test mode with `KILN_TEST_SETUP_DONE`: start as if setup had been finished. */
  assumeDone?: boolean;
  /** A dev instance (`kiln dev`): it never offers or imports the old board's real Projects. */
  devInstance?: boolean;
  /** The current demo run's mode (`GET /api/demo`): on a dev instance, Replay needs no role models to finish. */
  demoMode?(): DemoMode | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface Setup {
  /** What an Admin chose, as stored. Read before the core starts its login adapter and Knowledge store. */
  settings(): SetupSettings;
  state(): Promise<SetupState>;
  update(change: unknown): Promise<SetupState>;
  importOldBoard(request: unknown): Promise<ImportResult>;
  complete(): Promise<SetupState>;
  /** Fills in the models chosen for the default Workflow's roles. */
  decorate(workflow: Workflow): Workflow;
  /** The default Workflow's roles that have no model chosen yet. */
  missingRoles(): string[];
  doctorCheck: DoctorCheck;
}

/** The stored settings alone, for startCore to read before anything else starts. */
export function readSetupSettings(db: DatabaseSync): SetupSettings {
  const row = db.prepare("SELECT value FROM core_settings WHERE key = 'setup'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as SetupSettings) : {};
}

export function createSetup(deps: SetupDeps): Setup {
  const { db, bus, work } = deps;
  const env = deps.env ?? process.env;
  const read = (key: string): unknown => {
    const row = db.prepare('SELECT value FROM core_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  };
  const write = (key: string, value: unknown) =>
    db
      .prepare('INSERT INTO core_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));

  let settings = readSetupSettings(db);
  const completedAt = () => read('setup.completedAt') as string | undefined;
  // Kiln has no default place for the old board: the person names its projects.json (in the wizard, a
  // setting or KILN_OLD_BOARD_REGISTRY), and with none given there is nothing to import.
  const registry = () => settings.oldBoardRegistry ?? (env.KILN_OLD_BOARD_REGISTRY || undefined);
  const widgetRepo = () => settings.widgetRepo ?? PUBLIC_WIDGET_REPO;

  const oldBoard = (path = registry()): SetupState['oldBoard'] => {
    if (path === undefined) return { found: false, projects: [] };
    if (deps.devInstance || !existsSync(path)) return { registry: path, found: false, projects: [] };
    let entries: RegistryEntry[];
    try {
      entries = readRegistry(path);
    } catch (err) {
      return { registry: path, found: true, error: `Kiln could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, projects: [] };
    }
    const board = oldBoardFolder(path);
    const registered = work.projects();
    return {
      registry: path,
      found: true,
      projects: entries
        .filter((e): e is { name?: unknown; path: string } => typeof e.path === 'string' && e.path !== '')
        .map((e) => {
          const projectPath = resolve(e.path);
          const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : basename(projectPath);
          const project: OldBoardProject = {
            name,
            path: projectPath,
            registered: registered.some((p) => resolve(p.path).toLowerCase() === projectPath.toLowerCase()),
          };
          if (inside(projectPath, board) || inside(board, projectPath)) project.skip = "the old board's own folder";
          else if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) project.skip = 'the folder is not on this PC';
          return project;
        }),
    };
  };

  const obsidian = (): SetupState['obsidian'] => {
    const found = obsidianPaths(env).find((p) => existsSync(p));
    const vault = existsSync(join(deps.running.knowledgeDir(), '.obsidian'));
    return found ? { installed: true, path: found, vault } : { installed: false, vault, suggestion: OBSIDIAN_SUGGESTION };
  };

  const missingRoles = (): string[] => defaultRoles().map((r) => r.role).filter((role) => !settings.roles?.[role]?.model);

  const missing = (): string[] => {
    const problems: string[] = [];
    if (deps.budgets().length === 0) problems.push('Set up at least one Budget.');
    // Replay runs every role on the fake Agent; Live, and every live instance, need a model per role.
    const replay = deps.devInstance === true && deps.demoMode?.() === 'replay';
    if (!replay) for (const role of missingRoles()) problems.push(`Choose a model for the ${role} role.`);
    return problems;
  };

  const save = (next: SetupSettings) => {
    write('setup', next);
    settings = next;
  };

  const checkKnowledgeDir = (value: unknown): string => {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new SetupError(400, 'The Knowledge store folder must be an absolute path');
    const folder = resolve(value);
    try {
      mkdirSync(folder, { recursive: true });
      accessSync(folder, constants.W_OK);
      const probe = join(folder, `.kiln-setup-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    } catch (err) {
      throw new SetupError(400, `Kiln cannot write to ${folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return folder;
  };

  const checkBrowseRoots = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new SetupError(400, 'browseRoots is a list of absolute folder paths');
    const roots: string[] = [];
    for (const raw of value) {
      if (typeof raw !== 'string' || !isAbsolute(raw)) throw new SetupError(400, `A browse root must be an absolute path: ${String(raw)}`);
      const folder = resolve(raw);
      if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new SetupError(400, `No folder at ${folder}`);
      if (!roots.some((r) => r.toLowerCase() === folder.toLowerCase())) roots.push(folder);
    }
    return roots;
  };

  /** The saved tool paths with the change applied: an empty path clears the tool (found on PATH again). */
  const checkToolPaths = (value: unknown, saved: Record<string, string> = {}): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupError(400, 'toolPaths maps each tool name to its absolute path');
    const next = { ...saved };
    for (const [name, raw] of Object.entries(value)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new SetupError(400, `A tool is named by lower-case letters, digits and dashes, not ${JSON.stringify(name)}`);
      if (typeof raw !== 'string') throw new SetupError(400, `The path of ${name} must be a string`);
      if (!raw.trim()) {
        delete next[name];
        continue;
      }
      if (!isAbsolute(raw.trim())) throw new SetupError(400, `The path of ${name} must be absolute, or empty to find it on PATH: ${raw}`);
      next[name] = resolve(raw.trim());
    }
    return next;
  };

  const checkRoles = (value: unknown): Record<string, RoleModel> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupError(400, 'roles maps each role to its model');
    const known = new Set(defaultRoles().map((r) => r.role));
    const budgetOf = (model: string) => deps.budgets().find((b) => b.models.includes(model));
    const roles: Record<string, RoleModel> = {};
    for (const [role, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!known.has(role)) throw new SetupError(400, `The default Workflow has no "${role}" role`);
      const choice = raw as Partial<RoleModel> | null;
      if (!choice || typeof choice.model !== 'string' || !choice.model.trim()) {
        throw new SetupError(400, `Choose a model for the ${role} role`);
      }
      const chosen: RoleModel = { model: choice.model.trim() };
      for (const model of [chosen.model, choice.fallbackModel]) {
        if (typeof model === 'string' && model && !budgetOf(model)) {
          throw new SetupError(400, `No Budget has the model "${model}": add it to a Budget first`);
        }
      }
      if (typeof choice.fallbackModel === 'string' && choice.fallbackModel.trim()) chosen.fallbackModel = choice.fallbackModel.trim();
      if (typeof choice.agent === 'string' && choice.agent.trim()) chosen.agent = choice.agent.trim();
      roles[role] = chosen;
    }
    return { ...settings.roles, ...roles };
  };

  const state = async (): Promise<SetupState> => {
    const local = await findLocalModelServer(localServerUrls(env));
    const installed = deps.widgets();
    const done = completedAt();
    return {
      completed: Boolean(done) || deps.assumeDone === true,
      ...(done ? { completedAt: done } : {}),
      settings,
      running: { login: deps.running.login, knowledgeDir: deps.running.knowledgeDir() },
      restartNeeded: settings.login !== undefined && settings.login !== deps.running.login,
      widgetRepo: widgetRepo(),
      obsidian: obsidian(),
      tailscale: { note: TAILSCALE_SERVE_NOTE, ...(await servesKiln()) },
      localModelServer: local,
      defaults: defaultBudgets(local),
      roles: defaultRoles(),
      agents: FIRST_PARTY_AGENTS.map((a) => ({ ...a, installed: installed.some((w) => w.id === a.id) })),
      tools: moduleTools(),
      oldBoard: oldBoard(),
    };
  };

  /** The tools the default module repo's modules name, and any other the Setting already has. */
  const moduleTools = () => {
    const modules = [...loadModules([{ folder: DEFAULT_MODULE_REPO, label: 'modules' }]).modules.values()].map((m) => m.module);
    return [...new Set([...toolsOf(modules), ...Object.keys(settings.toolPaths ?? {})])].sort();
  };

  const servesKiln = async () => {
    const served = await deps.servedByTailscale();
    return served ? { servesKiln: served } : {};
  };

  return {
    settings: () => settings,
    state,
    async update(change) {
      if (!change || typeof change !== 'object') throw new SetupError(400, 'Send the settings to change');
      const c = change as Record<string, unknown>;
      const next: SetupSettings = { ...settings };
      if (c.login !== undefined) {
        if (c.login !== 'local' && c.login !== 'tailscale') throw new SetupError(400, 'login is local or tailscale');
        next.login = c.login;
      }
      if (c.install !== undefined) {
        if (c.install !== 'work' && c.install !== 'home') throw new SetupError(400, 'install is work or home');
        next.install = c.install;
      }
      if (c.widgetRepo !== undefined) {
        if (typeof c.widgetRepo !== 'string') throw new SetupError(400, 'widgetRepo is a git URL or folder');
        if (c.widgetRepo.trim()) next.widgetRepo = c.widgetRepo.trim();
        else delete next.widgetRepo;
      }
      if (c.oldBoardRegistry !== undefined) {
        if (typeof c.oldBoardRegistry !== 'string' || !isAbsolute(c.oldBoardRegistry)) {
          throw new SetupError(400, "oldBoardRegistry is the absolute path of the old board's projects.json");
        }
        next.oldBoardRegistry = resolve(c.oldBoardRegistry);
      }
      if (c.roles !== undefined) next.roles = checkRoles(c.roles);
      if (c.projectsFolder !== undefined) {
        if (typeof c.projectsFolder !== 'string' || !isAbsolute(c.projectsFolder)) {
          throw new SetupError(400, 'The Projects folder must be an absolute path');
        }
        const folder = resolve(c.projectsFolder);
        try {
          mkdirSync(folder, { recursive: true });
        } catch (err) {
          throw new SetupError(400, `Kiln cannot make ${folder}: ${err instanceof Error ? err.message : String(err)}`);
        }
        next.projectsFolder = folder;
      }
      if (c.browseRoots !== undefined) next.browseRoots = checkBrowseRoots(c.browseRoots);
      if (c.toolPaths !== undefined) next.toolPaths = checkToolPaths(c.toolPaths, settings.toolPaths);
      let moveTo: string | undefined;
      if (c.knowledgeDir !== undefined) {
        moveTo = checkKnowledgeDir(c.knowledgeDir);
        next.knowledgeDir = moveTo;
      }
      save(next);
      if (moveTo) deps.moveKnowledge(moveTo);
      return state();
    },
    async importOldBoard(request) {
      if (deps.devInstance) throw new SetupError(409, DEV_IMPORT_REFUSED);
      const body = (request ?? {}) as { registry?: unknown; paths?: unknown };
      if (body.registry !== undefined && (typeof body.registry !== 'string' || !isAbsolute(body.registry))) {
        throw new SetupError(400, "registry is the absolute path of the old board's projects.json");
      }
      const wanted = Array.isArray(body.paths) ? new Set(body.paths.filter((p): p is string => typeof p === 'string').map((p) => resolve(p).toLowerCase())) : undefined;
      const board = oldBoard(typeof body.registry === 'string' ? resolve(body.registry) : undefined);
      if (!board.found) {
        throw new SetupError(404, board.registry ? `No old board registry at ${board.registry}` : 'No old board is set: give the path of its projects.json');
      }
      if (board.error) throw new SetupError(400, board.error);
      const result: ImportResult = { imported: [], skipped: [] };
      for (const project of board.projects) {
        if (wanted && !wanted.has(project.path.toLowerCase())) continue;
        const skip = project.skip ?? (project.registered ? 'already registered' : undefined);
        if (skip) {
          result.skipped.push({ name: project.name, path: project.path, reason: skip });
          continue;
        }
        try {
          result.imported.push(await work.register({ path: project.path, name: project.name }));
        } catch (err) {
          result.skipped.push({ name: project.name, path: project.path, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      write('setup.importedAt', new Date().toISOString());
      return result;
    },
    async complete() {
      const problems = missing();
      if (problems.length) throw new SetupError(409, `Setup is not finished: ${problems.join(' ')}`);
      const at = new Date().toISOString();
      write('setup.completedAt', at);
      bus.publish('setup.completed', { completedAt: at });
      return state();
    },
    decorate(workflow) {
      const roles = settings.roles;
      if (workflow.name !== DEFAULT_WORKFLOW.name || !roles) return workflow;
      return {
        ...workflow,
        kinds: workflow.kinds.map((kind) => ({
          ...kind,
          stages: kind.stages.map((stage) => {
            const chosen = stage.role ? roles[stage.role] : undefined;
            if (!chosen || stage.model) return stage;
            return {
              ...stage,
              model: chosen.model,
              ...(chosen.fallbackModel && !stage.fallbackModel ? { fallbackModel: chosen.fallbackModel } : {}),
              ...(chosen.agent && !stage.agent ? { agent: chosen.agent } : {}),
            };
          }),
        })),
      };
    },
    missingRoles,
    doctorCheck: {
      id: 'setup',
      name: 'Setup',
      run() {
        if (completedAt() || deps.assumeDone) return { status: 'pass', detail: 'The setup wizard has been finished.' };
        return {
          status: 'not-configured',
          detail: `Kiln has not been set up yet. ${missing().join(' ')}`.trim(),
          fix: 'Open the Shell as an Admin: it starts the setup wizard (or go to Settings, Run setup again).',
        };
      },
    },
  };
}
