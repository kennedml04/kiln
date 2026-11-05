// The git check on registering a Project: every Project is a git repo, registered at the top of
// its work tree, on its default branch, with at least one commit. Kiln never switches branches or
// commits into an existing repo for you; it only offers to initialise a folder that isn't a repo.
import type { RepoRefusal } from '@kiln/widget-sdk';
import { currentBranch, defaultBranch, git } from '../flow/git.ts';

export interface RepoProblem {
  reason: RepoRefusal;
  /** What is wrong and the fix, for the person. */
  message: string;
}

const answers = async (cwd: string, ...args: string[]): Promise<string | undefined> => {
  try {
    return await git(cwd, ...args);
  } catch {
    return undefined;
  }
};

/** What stops `path` (an existing folder) from being registered, or undefined when nothing does. */
export async function repoProblem(path: string): Promise<RepoProblem | undefined> {
  // `--show-prefix` is the folder's place below the top of its work tree: empty at the top.
  const prefix = await answers(path, 'rev-parse', '--show-prefix');
  if (prefix === undefined) {
    return {
      reason: 'not-a-repo',
      message: `${path} is not a git repo. Every Project is one: choose Initialise as a git repo to make it one with a first commit, or run \`git init\` there yourself.`,
    };
  }
  if (prefix.trim() !== '') {
    const top = (await answers(path, 'rev-parse', '--show-toplevel'))?.trim() ?? 'the repo';
    return {
      reason: 'not-repo-top',
      message: `${path} is inside a git repo, not at the top of its repo (${top}). Register the repo's top folder instead.`,
    };
  }
  if ((await answers(path, 'rev-parse', '--verify', '--quiet', 'HEAD')) === undefined) {
    return {
      reason: 'no-commits',
      message: `${path} is a git repo with no commits yet. Make a first commit there (\`git add -A\` then \`git commit -m "First commit"\`), then register it again.`,
    };
  }
  const base = await defaultBranch(path);
  const branch = await currentBranch(path);
  if (branch !== base) {
    return {
      reason: 'off-default-branch',
      message: `${path} is on ${branch ?? 'a detached HEAD'}, not its default branch ${base}. Run \`git switch ${base}\` there (commit or stash your changes first), then register it again. Kiln never switches branches for you.`,
    };
  }
  return undefined;
}

/** Initialise as a git repo: `git init -b main`, then one commit of what the folder holds, as Kiln. */
export async function initialiseRepo(path: string): Promise<void> {
  await git(path, 'init', '-q', '-b', 'main');
  await git(path, 'add', '-A');
  await git(path, 'commit', '-q', '--allow-empty', '-m', 'Initial commit');
}
