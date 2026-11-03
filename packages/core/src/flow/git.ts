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
 * An existing worktree at `path` is reused as it is.
 */
export async function ensureWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path)) {
    if (await succeeds(path, 'rev-parse', '--is-inside-work-tree')) return;
    throw new Error(`${path} exists and is not a worktree`);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (await succeeds(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) {
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
export function worktreePath(dataDir: string, projectId: string, itemKey: string): string {
  return join(dataDir, 'worktrees', projectId, itemKey.replaceAll('/', '-'));
}

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

/** Merges `branch` into the branch checked out at `repo` (a merge commit, as Kiln); returns the new HEAD. */
export async function mergeBranch(repo: string, branch: string, message: string): Promise<string> {
  await git(repo, 'merge', '--no-ff', '-m', message, branch);
  return (await git(repo, 'rev-parse', 'HEAD')).trim();
}

/** Removes a merged Item's worktree and its branch. */
export async function removeWorktree(repo: string, path: string, branch: string): Promise<void> {
  if (existsSync(path)) await git(repo, 'worktree', 'remove', '--force', path);
  await git(repo, 'worktree', 'prune');
  await git(repo, 'branch', '-d', branch);
}

/** Uncommitted changes in `cwd` (porcelain status lines), empty when the tree is clean. */
export async function uncommitted(cwd: string): Promise<string[]> {
  return (await git(cwd, 'status', '--porcelain')).split('\n').filter((line) => line.trim());
}
