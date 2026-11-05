// The demo Project on a dev instance (demo-project spec, "Demo setup (core)"): `startDemo(mode)`
// throws the last demo run away and starts a fresh one from `packages/demo/template/`.
//
// Each run gets its own folder, `<dataDir>/demo/<run>/`, and its own Project id, `demo-<run>`
// (display name "Demo"). Reusing an id would bring the old run's Threads and events back with it.
//
// Replay (spec, "Replay: routing every role to the fake Agent") adds two steps: a Project Workflow
// that puts every role on the fake Agent, and the fake Agent itself, reading `packages/demo/replay/scripts.json`.
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DemoMode, DemoState, Project, Workflow } from '@kiln/widget-sdk';
import type { UsageService } from '../budgets/usage.ts';
import { git } from '../flow/git.ts';
import { WidgetHostError } from '../widget-host.ts';
import type { WidgetLifecycle } from '../widgets/lifecycle.ts';
import { DEFAULT_WORKFLOW } from '../work/default-workflow.ts';
import type { Work } from '../work/work.ts';

export class DemoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PACKAGES = resolve(import.meta.dirname, '..', '..', '..');
const TEMPLATE = join(PACKAGES, 'demo', 'template');
/** Replay's scripts live outside the template, so the person never reads them in the demo repo. */
const REPLAY_SCRIPTS = join(PACKAGES, 'demo', 'replay', 'scripts.json');
/** The scripted fake Agent Widget, installed straight from this checkout: one copy, which the suite exercises. */
const FAKE_AGENT_DIR = join(PACKAGES, 'testing', 'src', 'fake-agent');
const FAKE_AGENT_WIDGET = 'fake-agent';
const FAKE_AGENT = 'fake';
const FAKE_MODEL = 'fake-model';
const REPLAY_BUDGET = 'replay';
const DEMO_NAME = 'Demo';
/**
 * The demo repo's own author, written into its `.git/config`: every commit in it, the first one's and
 * each Agent's in its worktrees, works on a machine with no git identity and never borrows the person's.
 */
const DEMO_IDENTITY = { 'user.name': 'Kiln demo', 'user.email': 'demo@kiln.invalid' };

export interface DemoDeps {
  db: DatabaseSync;
  work: Work;
  dataDir: string;
  /** Only a dev instance (`kiln dev`) offers the demo. */
  devInstance: boolean;
  /** The default Workflow's roles that have no model yet (setup's roles). */
  missingRoles(): string[];
  /** The core's own Widget installs: Replay installs and approves the fake Agent through them. */
  widgets: Pick<WidgetLifecycle, 'list' | 'install' | 'approve' | 'start'>;
  /** Kiln starts no Session on a model in no Budget, so Replay gives `fake-model` one of its own. */
  budgets: Pick<UsageService, 'budgets' | 'setBudget'>;
}

export interface Demo {
  state(): DemoState;
  /** `by` is the Admin who started it: Replay approves the fake Agent in their name. */
  startDemo(mode: unknown, by?: string): Promise<DemoState>;
}

/**
 * Replay's Project Workflow (`.kiln/workflow.json`): the default Workflow named `demo-replay`, with
 * every Stage that has a role on the fake Agent. `setup.decorate()` fills role models only into the
 * Workflow named `default`, so the wizard's choices never reach it.
 */
export const replayWorkflow = (): Workflow => ({
  ...DEFAULT_WORKFLOW,
  name: 'demo-replay',
  kinds: DEFAULT_WORKFLOW.kinds.map((kind) => ({
    ...kind,
    stages: kind.stages.map((stage) => (stage.role ? { ...stage, agent: FAKE_AGENT, model: FAKE_MODEL } : stage)),
  })),
});

/** What a mode adds to the shared steps. */
interface ModeSteps {
  /** Refuses (409) while the mode can't run; called before the last run is thrown away. */
  check(): void;
  /** Runs in the copied folder before the commit. */
  beforeCommit?(folder: string): void | Promise<void>;
  /** Runs once the folder is registered as the demo Project; a failure unregisters it again. */
  afterRegister?(project: Project, by: string): void | Promise<void>;
}

const inside = (parent: string, child: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

// The promise form retries while a git or Agent process that just ended still holds the folder (Windows).
const removeFolder = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

export function createDemo(deps: DemoDeps): Demo {
  const { db, work, widgets } = deps;
  const runsDir = join(deps.dataDir, 'demo');
  const read = (key: string): unknown => {
    const row = db.prepare('SELECT value FROM core_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  };
  const write = (key: string, value: unknown) =>
    db
      .prepare('INSERT INTO core_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  const forget = (key: string) => db.prepare('DELETE FROM core_settings WHERE key = ?').run(key);

  /**
   * The fake Agent for Replay: installed from the checkout and approved by the Admin, unless it is
   * installed already (then it is reused, approved or started if it needs to be). Its script is a
   * fresh copy of the replay scripts in the data folder, so a changed checkout is picked up.
   */
  const ensureFakeAgent = async (by: string) => {
    const scriptFile = join(runsDir, 'replay', 'scripts.json');
    mkdirSync(join(runsDir, 'replay'), { recursive: true });
    copyFileSync(REPLAY_SCRIPTS, scriptFile);
    const installed = widgets.list().find((w) => w.id === FAKE_AGENT_WIDGET);
    if (!installed) {
      await widgets.install({ source: FAKE_AGENT_DIR, config: { scriptFile } });
      await widgets.approve(FAKE_AGENT_WIDGET, by);
    } else if (!installed.grants) await widgets.approve(FAKE_AGENT_WIDGET, by);
    else if (installed.state === 'stopped' || installed.state === 'unhealthy') widgets.start(FAKE_AGENT_WIDGET);
  };

  /**
   * Replay's Budget: `fake-model` alone, metered. The fake Agent reports no cost, so its turns are
   * recorded (the usage display has something to show) but draw nothing. Left alone when
   * `fake-model` already belongs to a Budget.
   */
  const ensureReplayBudget = () => {
    if (deps.budgets.budgets().some((b) => b.models.includes(FAKE_MODEL))) return;
    deps.budgets.setBudget(REPLAY_BUDGET, { kind: 'metered', name: 'Replay (fake Agent)', models: [FAKE_MODEL] });
  };

  const modes: Record<DemoMode, ModeSteps> = {
    live: {
      check() {
        const missing = deps.missingRoles();
        if (missing.length) {
          throw new DemoError(409, `Live runs on your role models: choose a model for ${missing.map((r) => `the ${r} role`).join(', ')} first`);
        }
      },
    },
    replay: {
      // Replay needs no role models: every role runs on the fake Agent.
      check() {},
      beforeCommit(folder) {
        mkdirSync(join(folder, '.kiln'), { recursive: true });
        writeFileSync(join(folder, '.kiln', 'workflow.json'), `${JSON.stringify(replayWorkflow(), null, 2)}\n`);
      },
      async afterRegister(_project, by) {
        await ensureFakeAgent(by);
        ensureReplayBudget();
      },
    },
  };

  const state = (): DemoState => {
    if (!deps.devInstance) return { available: false };
    const projectId = read('demo.projectId') as string | undefined;
    const mode = read('demo.mode') as DemoMode | undefined;
    return { available: true, ...(mode ? { mode } : {}), ...(projectId && work.project(projectId) ? { projectId } : {}) };
  };

  /** Step 1: unregister the last run's Project (stopping its Sessions, removing its worktrees) and delete its folder. */
  const throwAwayLastRun = async () => {
    const projectId = read('demo.projectId') as string | undefined;
    const project = projectId ? work.project(projectId) : undefined;
    if (project) await work.unregister(project.id);
    forget('demo.projectId');
    forget('demo.mode');
    if (project && inside(runsDir, project.path)) await removeFolder(project.path);
  };

  /** Step 2: a copy of the template in a folder, and a Project id, that no run has used. */
  const copyTemplate = () => {
    let run = Number(read('demo.run') ?? 0);
    let folder: string;
    do folder = join(runsDir, String(++run));
    while (existsSync(folder) || work.project(`demo-${run}`));
    write('demo.run', run);
    cpSync(TEMPLATE, folder, { recursive: true });
    return { folder, id: `demo-${run}` };
  };

  const commit = async (folder: string) => {
    await git(folder, 'init', '-q', '-b', 'main');
    for (const [key, value] of Object.entries(DEMO_IDENTITY)) await git(folder, 'config', key, value);
    await git(folder, 'add', '-A');
    // Kiln's own `git` names Kiln as the author on the command line, over the config, so name the demo here too.
    const asDemo = Object.entries(DEMO_IDENTITY).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
    await git(folder, ...asDemo, 'commit', '-q', '-m', 'Demo project');
  };

  return {
    state,
    async startDemo(mode, by = 'kiln') {
      if (!deps.devInstance) throw new DemoError(409, 'The demo runs only on a dev instance (kiln dev)');
      if (mode !== 'live' && mode !== 'replay') throw new DemoError(400, 'mode is replay or live');
      const steps = modes[mode];
      steps.check();
      await throwAwayLastRun();
      const { folder, id } = copyTemplate();
      let project: Project | undefined;
      try {
        await steps.beforeCommit?.(folder);
        await commit(folder);
        project = await work.register({ path: folder, name: DEMO_NAME }, { id });
        write('demo.projectId', project.id);
        await steps.afterRegister?.(project, by);
      } catch (err) {
        if (project) {
          await work.unregister(project.id);
          forget('demo.projectId');
        }
        await removeFolder(folder);
        // The Widget source policy's refusal, word for word; the policy is never loosened here.
        if (err instanceof WidgetHostError) throw new DemoError(err.status, err.message);
        throw err;
      }
      write('demo.mode', mode);
      return state();
    },
  };
}
