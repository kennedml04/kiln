// + Project → New (project-wizard ticket 02): `POST /api/projects/new` (Admin only, see access.ts).
// It makes `<Projects folder>\<name>`, writes a README, `.kiln/settings.json` and a `.gitignore`,
// runs `git init -b main` and commits once as Kiln (the identity Kiln commits Tracker records as),
// registers the Project and creates the grill-stage Story "What we're building" through its Tracker.
//
// Every step can be run again: a step that fails names itself and leaves the folder in place,
// unregistered, and asking again skips what is already done (files are never overwritten).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, NewProjectRequest, NewProjectResult, NewProjectStep, Project } from '@kiln/widget-sdk';
import { git } from '../flow/git.ts';
import type { RouteHelpers } from './routes.ts';
import { WorkError, type Work } from './work.ts';

export const FIRST_STORY_TITLE = "What we're building";

const STEPS: { id: NewProjectStep; name: string }[] = [
  { id: 'folder', name: 'make the folder' },
  { id: 'files', name: 'write the README, settings and .gitignore' },
  { id: 'git', name: 'git init and the first commit' },
  { id: 'register', name: 'register the Project' },
  { id: 'story', name: `create the "${FIRST_STORY_TITLE}" Story` },
];

/** What New itself writes in a folder; any other entry means the folder is someone else's. */
const OURS = new Set(['.git', '.gitignore', '.kiln', '.scratch', 'readme.md']);

const GITIGNORE = ['# Local files that stay out of git', 'node_modules/', '.env', '.DS_Store', 'Thumbs.db', ''].join('\n');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A failed step of New, named. */
export class NewProjectError extends WorkError {
  readonly step: NewProjectStep;
  constructor(status: number, step: NewProjectStep, cause: unknown) {
    const at = STEPS.findIndex((s) => s.id === step);
    const why = cause instanceof Error ? cause.message : String(cause);
    super(status, `Step ${at + 1} of ${STEPS.length} (${STEPS[at]!.name}) failed: ${why.trim()}`);
    this.step = step;
  }
}

/** Checks a Project name is one portable folder name; returns it trimmed. */
function checkName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new WorkError(400, 'A new Project needs a name');
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new WorkError(400, `"${name}" can't be a folder name: leave out < > : " / \\ | ? * and control characters`);
  }
  if (name === '.' || name === '..' || /[. ]$/.test(name) || RESERVED.test(name)) {
    throw new WorkError(400, `"${name}" can't be a folder name on every system; choose another`);
  }
  if (name.length > 100) throw new WorkError(400, 'A Project name is at most 100 characters');
  return name;
}

function checkDescription(raw: unknown): string {
  const description = typeof raw === 'string' ? raw.trim() : '';
  if (!description) throw new WorkError(400, 'A new Project needs a one-line description');
  if (/[\r\n]/.test(description)) throw new WorkError(400, 'The description is one line');
  return description;
}

const writeIfMissing = (path: string, content: string) => {
  if (!existsSync(path)) writeFileSync(path, content);
};

/** True when `folder` is the top of its own git work tree (not a folder inside another repo). */
const ownRepo = async (folder: string) => {
  try {
    return (await git(folder, 'rev-parse', '--show-prefix')).trim() === '';
  } catch {
    return false;
  }
};

const hasCommit = async (folder: string) => {
  try {
    await git(folder, 'rev-parse', '--verify', '--quiet', 'HEAD');
    return true;
  } catch {
    return false;
  }
};

export interface NewProjectDeps {
  work: Work;
  /** The Projects folder setting; undefined until the person sets it. */
  projectsFolder(): string | undefined;
}

export interface NewProjects {
  create(request: NewProjectRequest): Promise<NewProjectResult>;
}

export function createNewProjects({ work, projectsFolder }: NewProjectDeps): NewProjects {
  // One New at a time, so two clicks never race on the same folder.
  let queue: Promise<unknown> = Promise.resolve();

  const run = async <T>(step: NewProjectStep, action: () => T | Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      throw new NewProjectError(err instanceof WorkError ? err.status : 500, step, err);
    }
  };

  const create = async (request: NewProjectRequest): Promise<NewProjectResult> => {
    const name = checkName(request?.name);
    const description = checkDescription(request?.description);
    const parent = projectsFolder();
    if (!parent) {
      throw new WorkError(409, 'Set the Projects folder first: New makes each Project in a folder of its own there', 'no-projects-folder');
    }
    const folder = join(parent, name);
    const registered = work.projects().find((p) => p.path.toLowerCase() === folder.toLowerCase());
    if (registered) throw new WorkError(409, `${folder} is already registered as "${registered.name}"`);
    if (existsSync(folder)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(folder);
      } catch {
        // Not a folder: step 1 names that.
      }
      const others = entries.filter((e) => !OURS.has(e.toLowerCase()));
      if (others.length) {
        throw new WorkError(409, `${folder} already holds other files (${others.slice(0, 3).join(', ')}). Choose another name, or Import that folder instead.`);
      }
    }

    await run('folder', () => mkdirSync(folder, { recursive: true }));
    await run('files', () => {
      mkdirSync(join(folder, '.kiln'), { recursive: true });
      writeIfMissing(join(folder, 'README.md'), `# ${name}\n\n${description}\n`);
      writeIfMissing(join(folder, '.kiln', 'settings.json'), `${JSON.stringify({ tracker: 'markdown' }, null, 2)}\n`);
      writeIfMissing(join(folder, '.gitignore'), GITIGNORE);
    });
    await run('git', async () => {
      if (!(await ownRepo(folder))) await git(folder, 'init', '-q', '-b', 'main');
      if (await hasCommit(folder)) return;
      await git(folder, 'add', '--', 'README.md', '.kiln/settings.json', '.gitignore');
      // `git` commits as Kiln; the message is the whole message, with no trailer.
      await git(folder, 'commit', '-q', '-m', `New Project: ${name}`);
    });
    const project: Project = await run('register', () => work.register({ path: folder, name }));
    try {
      const item: Item =
        work.items(project.id).find((i) => i.kind === 'story' && i.title === FIRST_STORY_TITLE) ??
        (await work.createItem(project.id, { kind: 'story', title: FIRST_STORY_TITLE, description }));
      return { project: work.project(project.id) ?? project, item };
    } catch (err) {
      // Leave the folder in place but unregistered, so asking again carries on from here.
      await work.unregister(project.id).catch(() => undefined);
      throw new NewProjectError(err instanceof WorkError ? err.status : 500, 'story', err);
    }
  };

  return {
    create(request) {
      const next = queue.then(() => create(request));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Answers `POST /api/projects/new`; returns false for any other request. */
export async function handleNewProjectRoute(
  projects: NewProjects,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  if (url.pathname !== '/api/projects/new' || req.method !== 'POST') return false;
  try {
    sendJson(res, 201, await projects.create(((await readJson(req)) ?? {}) as NewProjectRequest));
  } catch (err) {
    if (!(err instanceof WorkError)) throw err;
    sendJson(res, err.status, {
      error: err.message,
      ...(err.reason ? { reason: err.reason } : {}),
      ...(err instanceof NewProjectError ? { step: err.step } : {}),
    });
  }
  return true;
}
