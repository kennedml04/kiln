// The demo Project on a dev instance (demo-project spec, "Demo setup (core)"): `startDemo(mode)`
// throws the last demo run away and starts a fresh one from `packages/demo/template/`.
//
// Each run gets its own folder, `<dataDir>/demo/<run>/`, and its own Project id, `demo-<run>`
// (display name "Demo"). Reusing an id would bring the old run's Threads and events back with it.
import { cpSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DemoMode, DemoState, Project } from '@kiln/widget-sdk';
import { git } from '../flow/git.ts';
import type { Work } from '../work/work.ts';

export class DemoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TEMPLATE = resolve(import.meta.dirname, '..', '..', '..', 'demo', 'template');
const DEMO_NAME = 'Demo';
/** The demo repo's own author, so the commit works on a machine with no git identity set. */
const AS_DEMO = ['-c', 'user.name=Kiln demo', '-c', 'user.email=demo@kiln.invalid'];

export interface DemoDeps {
  db: DatabaseSync;
  work: Work;
  dataDir: string;
  /** Only a dev instance (`kiln dev`) offers the demo. */
  devInstance: boolean;
  /** The default Workflow's roles that have no model yet (setup's roles). */
  missingRoles(): string[];
}

export interface Demo {
  state(): DemoState;
  startDemo(mode: unknown): Promise<DemoState>;
}

/** What a mode adds to the shared steps. Replay (Ticket 06) adds its Workflow file and the fake Agent. */
interface ModeSteps {
  /** Refuses (409) while the mode can't run; called before the last run is thrown away. */
  check(): void;
  /** Runs in the copied folder before the commit. */
  beforeCommit?(folder: string): void | Promise<void>;
  /** Runs once the folder is registered as the demo Project. */
  afterRegister?(project: Project): void | Promise<void>;
}

const inside = (parent: string, child: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

// The promise form retries while a git or Agent process that just ended still holds the folder (Windows).
const removeFolder = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

export function createDemo(deps: DemoDeps): Demo {
  const { db, work } = deps;
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

  const modes: Record<'live', ModeSteps> = {
    live: {
      check() {
        const missing = deps.missingRoles();
        if (missing.length) {
          throw new DemoError(409, `Live runs on your role models: choose a model for ${missing.map((r) => `the ${r} role`).join(', ')} first`);
        }
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
    await git(folder, 'add', '-A');
    await git(folder, ...AS_DEMO, 'commit', '-q', '-m', 'Demo project');
  };

  return {
    state,
    async startDemo(mode) {
      if (!deps.devInstance) throw new DemoError(409, 'The demo runs only on a dev instance (kiln dev)');
      if (mode !== 'live') throw new DemoError(400, 'mode is live');
      const steps = modes[mode];
      steps.check();
      await throwAwayLastRun();
      const { folder, id } = copyTemplate();
      let project: Project;
      try {
        await steps.beforeCommit?.(folder);
        await commit(folder);
        project = await work.register({ path: folder, name: DEMO_NAME }, { id });
      } catch (err) {
        await removeFolder(folder);
        throw err;
      }
      write('demo.projectId', project.id);
      await steps.afterRegister?.(project);
      write('demo.mode', mode);
      return state();
    },
  };
}
