// Linked Projects in one Session: a client Project's Item works in a task folder holding a worktree
// of the client and of each Project it links, side by side, all on the Item's one branch name.
//
//   <data>/worktrees/<client id>/<item key>/<client name>/   the client's worktree
//   <data>/worktrees/<client id>/<item key>/<linked name>/   each linked Project's worktree
//
// When the Session ends every worktree it made goes; a linked repo it never touched also loses its
// branch (no branch, no review, no landing).
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LinkedProjectSettings, Project } from '@kiln/widget-sdk';
import { removeFolder, run } from '../exec.ts';
import { commitsAhead, defaultBranch, ensureWorktree, folderName, git, removeWorktree, uncommitted, worktreePath } from './git.ts';

/** One repo in a Session's task folder. */
export interface LinkedRepo {
  project: Project;
  worktree: string;
  base: string;
  /** The client's own repo is never dropped; a linked one is when the Session left it untouched. */
  client: boolean;
}

/** What a client Session made: the task folder and every repo's worktree in it. */
export interface LinkedSetup {
  folder: string;
  repos: LinkedRepo[];
  /** Files in the client the link commands change: not counted as the Session's own changes. */
  linkFiles: string[];
}

export class LinkedProjectError extends Error {}

/** The task folder of a client Project's Item. */
export const taskFolder = (dataDir: string, project: Project, itemKey: string): string =>
  dirname(worktreePath(dataDir, project, itemKey));

/** The Projects `project` links, by the name its settings gives them (a Project's name or id). */
export function linkedProjectsOf(all: Project[], project: Project): { name: string; project: Project; settings: LinkedProjectSettings }[] {
  return Object.entries(project.settings.linkedProjects ?? {}).map(([name, settings]) => {
    const found = all.find((p) => p.id !== project.id && (p.id === name || p.name.toLowerCase() === name.toLowerCase()));
    if (!found) throw new LinkedProjectError(`${project.name} links "${name}", which is not a Project in Kiln`);
    return { name, project: found, settings };
  });
}

/** Runs `command` in `cwd` through the shell. */
const runShell = async (command: string, cwd: string) => {
  try {
    await run(command, { cwd, shell: true, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new LinkedProjectError(`The link command \`${command}\` failed in ${cwd}: ${(e.stderr || e.stdout || e.message || '').toString().trim()}`);
  }
};

/**
 * Makes the client's worktree and a worktree of each linked Project on `branch`, then runs each
 * link command in the client worktree. Anything made is undone if a step fails.
 */
export async function setupLinked(args: {
  dataDir: string;
  all: Project[];
  client: Project;
  itemKey: string;
  branch: string;
  clientBase: string;
}): Promise<LinkedSetup> {
  const { dataDir, all, client, itemKey, branch, clientBase } = args;
  const links = linkedProjectsOf(all, client);
  const folder = taskFolder(dataDir, client, itemKey);
  const setup: LinkedSetup = {
    folder,
    repos: [{ project: client, worktree: worktreePath(dataDir, client, itemKey), base: clientBase, client: true }],
    linkFiles: links.flatMap((l) => l.settings.linkFiles ?? []),
  };
  try {
    await ensureWorktree(client.path, setup.repos[0]!.worktree, branch, clientBase);
    for (const link of links) {
      const base = await defaultBranch(link.project.path);
      const worktree = join(folder, folderName(link.name));
      setup.repos.push({ project: link.project, worktree, base, client: false });
      await ensureWorktree(link.project.path, worktree, branch, base);
    }
    for (const link of links) if (link.settings.link) await runShell(link.settings.link, setup.repos[0]!.worktree);
  } catch (err) {
    await cleanupLinked(setup).catch(() => undefined);
    throw err;
  }
  return setup;
}

/** Whether a repo's worktree holds nothing the Session made: no commits past its base, no changes. */
const untouched = async (repo: LinkedRepo): Promise<boolean> =>
  existsSync(repo.worktree) && (await commitsAhead(repo.worktree, repo.base)) === 0 && (await uncommitted(repo.worktree)).length === 0;

/**
 * The Session ended: removes every worktree it made, and drops a linked repo it never touched (its
 * branch goes too). A worktree with uncommitted changes is left alone so nothing is lost.
 */
export async function cleanupLinked(setup: LinkedSetup, branch?: string): Promise<void> {
  const linkFiles = new Set(setup.linkFiles);
  for (const repo of setup.repos) {
    if (!existsSync(repo.worktree)) continue;
    const name = branch ?? (await git(repo.worktree, 'symbolic-ref', '--short', 'HEAD').catch(() => '')).trim();
    const drop = !repo.client && (await untouched(repo));
    // Changes the link command made (its linkFiles) are not the Session's work.
    const mine = (await uncommitted(repo.worktree)).filter((line) => !linkFiles.has(line.slice(3).trim()));
    if (mine.length > 0) continue;
    await removeWorktree(repo.project.path, repo.worktree).catch(() => undefined);
    if (drop && name) await git(repo.project.path, 'branch', '-D', name).catch(() => undefined);
  }
  // The task folder goes once nothing is left in it.
  if (existsSync(setup.folder) && readdirSync(setup.folder).length === 0) await removeFolder(setup.folder).catch(() => undefined);
}

/** The Item merged: whatever is left of its task folder goes (linked repos' leftovers are worktrees only). */
export async function removeTaskFolder(dataDir: string, project: Project, itemKey: string): Promise<void> {
  if (!Object.keys(project.settings.linkedProjects ?? {}).length) return;
  const folder = taskFolder(dataDir, project, itemKey);
  if (existsSync(folder) && readdirSync(folder).length === 0) await removeFolder(folder);
}
