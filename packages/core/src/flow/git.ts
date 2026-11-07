// The git a Project needs from Kiln: its default branch, and one worktree and branch per Item Stage-run.
// `git` and `gitSync` are the core's one way to run git: every commit Kiln makes is made as Kiln.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { run } from '../exec.ts';

/** Kiln's own git identity, so its commits work on a machine with no git identity set. */
const AS_KILN = ['-c', 'user.name=Kiln', '-c', 'user.email=kiln@localhost'];

/** Runs git in `cwd` as Kiln and returns stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', [...AS_KILN, ...args], { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/** `git`, blocking: for the few callers that can't wait (Widget installs, the Policy template). */
export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...AS_KILN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const succeeds = async (cwd: string, ...args: string[]) => {
  try {
    await git(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

/** The branch work merges into: origin's HEAD if known, else `main`, else `master`, else the checkout's branch. */
export async function defaultBranch(repo: string): Promise<string> {
  try {
    return (await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, '');
  } catch {
    // No remote HEAD.
  }
  for (const name of ['main', 'master']) {
    if (await succeeds(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`)) return name;
  }
  return (await git(repo, 'symbolic-ref', '--short', 'HEAD')).trim();
}

/** The branch checked out in `cwd`, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, 'symbolic-ref', '--short', 'HEAD')).trim();
  } catch {
    return null;
  }
}

/**
 * Makes sure `path` is a worktree of `repo` on `branch`, creating the branch from `base` if it is new.
 * An existing worktree at `path` is reused as it is, unless it is stale: left behind by a merge whose
 * cleanup failed (its branch holds nothing `base` lacks and is behind it, with nothing uncommitted).
 * A stale one is made again from `base`; if it still can't be removed, it is reused.
 */
export async function ensureWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  const stale = async () =>
    (await isMerged(repo, branch, base)) && !(await isMerged(repo, base, branch));
  if (existsSync(path)) {
    if (!(await succeeds(path, 'rev-parse', '--is-inside-work-tree'))) throw new Error(`${path} exists and is not a worktree`);
    if (!(await stale()) || (await uncommitted(path)).length > 0) return;
    try {
      await removeWorktree(repo, path, branch);
    } catch {
      return;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const branchExists = await succeeds(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
  if (branchExists && (await stale())) await git(repo, 'branch', '-D', branch);
  if (branchExists && (await succeeds(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`))) {
    await git(repo, 'worktree', 'add', path, branch);
  } else {
    await git(repo, 'worktree', 'add', '-b', branch, path, base);
  }
}

/**
 * The commit a checkout (main or worktree) is at, read straight from the git folder so it can be
 * taken the moment an event arrives, without waiting on a git process. Undefined when it can't be
 * read (no repo, an unborn branch).
 */
export function readHead(dir: string): string | undefined {
  try {
    let gitDir = join(dir, '.git');
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = resolve(dir, pointer);
    }
    const commonFile = join(gitDir, 'commondir');
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return head;
    for (const base of [gitDir, commonDir]) {
      const file = join(base, ref);
      if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    }
    const packed = join(commonDir, 'packed-refs');
    if (!existsSync(packed)) return undefined;
    const line = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line?.split(' ')[0];
  } catch {
    return undefined;
  }
}

/** How many commits `cwd`'s HEAD has that `base` does not. */
export async function commitsAhead(cwd: string, base: string): Promise<number> {
  return Number((await git(cwd, 'rev-list', '--count', `${base}..HEAD`)).trim());
}

/** Where an Item's Stage-runs work: one worktree per Item, kept across its Stages until it merges. */
export function worktreePath(dataDir: string, project: { id: string; name: string; settings: { linkedProjects?: object } }, itemKey: string): string {
  const folder = join(dataDir, 'worktrees', project.id, itemKey.replaceAll('/', '-'));
  // A client Project's Items work in a task folder: the client's worktree sits beside its linked Projects'.
  return Object.keys(project.settings.linkedProjects ?? {}).length ? join(folder, folderName(project.name)) : folder;
}

/** A Project name as a folder name. */
export const folderName = (name: string): string => name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-') || 'project';

/** A file's content at `rev` (default HEAD) as seen from `cwd`, or undefined when it is not there. */
export async function fileAtHead(cwd: string, path: string, rev = 'HEAD'): Promise<string | undefined> {
  try {
    return await git(cwd, 'show', `${rev}:${path}`);
  } catch {
    return undefined;
  }
}

/** `git diff --stat` of `branch` against the point where it left `base`. */
export async function diffSummary(repo: string, base: string, branch: string): Promise<string> {
  return (await git(repo, 'diff', '--stat', `${base}...${branch}`)).trimEnd();
}

/**
 * The files that would conflict if `branch` merged into `base`, without touching any checkout
 * (`git merge-tree`). Empty when the merge is clean.
 */
export async function mergeConflicts(repo: string, base: string, branch: string): Promise<string[]> {
  try {
    await git(repo, 'merge-tree', '--write-tree', '--name-only', '--no-messages', base, branch);
    return [];
  } catch (err) {
    const stdout = String((err as { stdout?: string }).stdout ?? '');
    const files = stdout.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
    if (files.length === 0) throw err;
    return files;
  }
}

/**
 * A Co-Authored-By trailer: the key, a name and an address in angle brackets, anywhere in the text
 * (on its own line, or folded into a one-line `git commit -m`). A sentence that only names the
 * trailer ("a Co-Authored-By: line") has no address and doesn't count.
 */
export const CO_AUTHORED_BY = /co-authored-by:[^\n<]*<[^>\n]*>/i;

/**
 * The commits in `range` (e.g. `main..HEAD`) whose message has a `Co-Authored-By:` trailer, in any
 * case, anywhere in the message: each as "<short hash> <subject>". Kiln never lets one reach the
 * default branch.
 */
export async function coAuthoredCommits(cwd: string, range: string): Promise<string[]> {
  const log = await git(cwd, 'log', '--format=%h %s%x00%B%x1e', range);
  return log
    .split('\x1e')
    .map((record) => record.replace(/^\s+/, ''))
    .filter((record) => CO_AUTHORED_BY.test(record.slice(record.indexOf('\0') + 1)))
    .map((record) => record.slice(0, record.indexOf('\0')));
}

/** What to tell whoever made `commits`: drop the trailer by rewriting their messages. */
export const coAuthoredFix = (commits: string[]) =>
  `These commits have a Co-Authored-By trailer, which Kiln never lets reach the default branch:\n${commits.map((c) => `- ${c}`).join('\n')}\nRewrite their messages without the trailer, keeping the changes: \`git commit --amend\` for the last commit, a rebase that amends each message for earlier ones.`;

/**
 * Merges `branch` into the branch checked out at `repo` (a merge commit, as Kiln); returns the new HEAD.
 * Refuses, leaving the checkout as it was, when a commit it would bring in has a Co-Authored-By trailer.
 */
export async function mergeBranch(repo: string, branch: string, message: string): Promise<string> {
  const coAuthored = await coAuthoredCommits(repo, `HEAD..${branch}`);
  if (coAuthored.length > 0) throw new Error(`Kiln did not merge ${branch}. ${coAuthoredFix(coAuthored)}`);
  await git(repo, 'merge', '--no-ff', '-m', message, branch);
  return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

/** Whether every commit on `branch` is already on `base` (a merge that already happened). */
export async function isMerged(repo: string, branch: string, base: string): Promise<boolean> {
  return succeeds(repo, 'merge-base', '--is-ancestor', branch, base);
}

/** How long removeWorktree keeps trying while a closing process still holds the folder (Windows). */
const REMOVE_TRIES_MS = [100, 250, 500, 1000, 2000, 3000];

/**
 * Removes a merged Item's worktree and its branch. On Windows a folder can't be removed while a
 * process works in it, and an Agent's process that was just told to stop takes a moment to exit,
 * so a failed removal is tried again for a few seconds before it gives up.
 */
export async function removeWorktree(repo: string, path: string, branch?: string): Promise<void> {
  for (let attempt = 0; existsSync(path); attempt++) {
    try {
      await git(repo, 'worktree', 'remove', '--force', path);
    } catch (err) {
      const wait = REMOVE_TRIES_MS[attempt];
      if (wait === undefined) throw err;
      await new Promise((done) => setTimeout(done, wait));
    }
  }
  await git(repo, 'worktree', 'prune');
  if (branch && (await succeeds(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`))) await git(repo, 'branch', '-d', branch);
}

/** Uncommitted changes in `cwd` (porcelain status lines), empty when the tree is clean. */
export async function uncommitted(cwd: string): Promise<string[]> {
  return (await git(cwd, 'status', '--porcelain')).split('\n').filter((line) => line.trim());
}
