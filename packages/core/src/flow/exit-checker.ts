// The Exit checker: Kiln checks a Stage's Exit itself, from git, the Project's tests and its modules' check commands.
// Nothing an Agent says counts towards it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  PROJECT_SETTINGS_FILE,
  type ExitCheckId,
  type ExitCheckResult,
  type ExitStatus,
  type ModuleExitCheck,
  type ModuleExitCheckId,
  type ProjectSettings,
} from '@kiln/widget-sdk';
import { parseModuleCheckId } from '../work/effective-workflow.ts';
import { expandModuleText, type ToolPaths } from '../work/module-commands.ts';
import { readProjectFiles } from '../work/project-files.ts';
import { coAuthoredCommits, coAuthoredFix, commitsAhead, fileAtHead, git, uncommitted } from './git.ts';

const TEST_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 4_000;

/** The checks Kiln itself knows; a module's `module:<module>/<check>` checks come from its file. */
type BuiltInExitCheckId = Exclude<ExitCheckId, ModuleExitCheckId>;

const NAMES: Record<BuiltInExitCheckId, string> = {
  branch_has_commits: 'Branch has commits',
  tree_clean: 'Working tree clean',
  tests_pass: 'Tests pass',
  findings_exist: 'Review findings committed',
  grill_record_exists: 'Grill record committed',
  spec_exists: 'Spec committed',
  children_exist: 'Child Items created',
  artifact_exists: 'Artifact committed',
  no_open_blocking_asks: 'No open blocking Asks',
  no_coauthor_trailers: 'No Co-Authored-By trailers',
};

/** Checked on every Stage with a worktree, after the Workflow's own checks: no Workflow can leave it out. */
export const BUILT_IN_WORKTREE_CHECKS: readonly ExitCheckId[] = ['no_coauthor_trailers'];

/** Every named check a Workflow can combine into an Exit. */
export const EXIT_CHECK_IDS: readonly ExitCheckId[] = Object.keys(NAMES) as BuiltInExitCheckId[];

/** The checks that read nothing from a worktree: the only ones a Stage without a worktree can use. */
export const WORKTREE_FREE_CHECKS: readonly ExitCheckId[] = ['children_exist', 'no_open_blocking_asks'];

/** Where a Story's grill record and spec go: beside its record (repo-relative). */
export const grillPathOf = (itemDir: string) => posix.join(itemDir, 'grill.md');
export const specPathOf = (itemDir: string) => posix.join(itemDir, 'spec.md');

/** Reads `.kiln/settings.json` from the Project's main checkout; `{}` when it is missing or unreadable. */
export function readProjectSettings(repo: string): ProjectSettings {
  try {
    return JSON.parse(readFileSync(join(repo, PROJECT_SETTINGS_FILE), 'utf8')) as ProjectSettings;
  } catch {
    return {};
  }
}

/** Runs a shell command in `cwd`; resolves with its exit code and the tail of its output. */
function runCommand(command: string, cwd: string, env?: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let output = '';
    const collect = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-OUTPUT_TAIL));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), TEST_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      done({ code: null, output: String(err) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, output: output.trim() });
    });
  });
}

export interface ExitContext {
  /** The Project's main checkout (settings are read from here, never from the worktree). */
  repo: string;
  /** The Stage's worktree; a Stage without one uses only the `WORKTREE_FREE_CHECKS`. */
  worktree?: string;
  /** The branch the Stage's branch started from. */
  base?: string;
  /** The `toolPaths` Setting, for `{tool:<name>}` in a module check's command. */
  toolPaths?: ToolPaths;
  /** The Item's record (repo-relative), which `artifact_exists` does not count. */
  itemPath?: string;
  /** Where the Item's review findings go (repo-relative), for `findings_exist`. */
  findingsPath?: string;
  /** The folder of the Item's record (repo-relative), for `grill_record_exists` and `spec_exists`. */
  itemDir?: string;
  /** How many child Items the Item has now, for `children_exist`. */
  children?: number;
  /** The questions of the Item's open blocking Asks, for `no_open_blocking_asks`. */
  openBlockingAsks?: string[];
}

type CheckOutcome = Omit<ExitCheckResult, 'id' | 'name'>;

async function committed(worktree: string, ctx: ExitContext, path: (dir: string) => string, what: string) {
  if (!ctx.itemDir) return { met: false, detail: `This Item has no place for its ${what}` };
  const file = path(ctx.itemDir);
  return (await fileAtHead(worktree, file)) !== undefined
    ? { met: true, detail: file }
    : { met: false, detail: `Write the ${what} to ${file} and commit it` };
}

async function check(id: ExitCheckId, ctx: ExitContext): Promise<CheckOutcome> {
  switch (id) {
    case 'children_exist':
      return (ctx.children ?? 0) > 0
        ? { met: true, detail: `${ctx.children} child Item(s)` }
        : { met: false, detail: 'Create each child Item with the create_child_item Kiln tool' };
    case 'no_open_blocking_asks': {
      const open = ctx.openBlockingAsks ?? [];
      return open.length === 0
        ? { met: true }
        : { met: false, detail: `Waiting on a person to answer:\n${open.map((q) => `- ${q}`).join('\n')}` };
    }
  }
  // The Workflow validator keeps every other check off a Stage without a worktree.
  if (!ctx.worktree || !ctx.base) return { met: false, detail: 'This Stage has no worktree to check' };
  return checkWorktree(id, { ...ctx, worktree: ctx.worktree, base: ctx.base });
}

async function checkWorktree(id: ExitCheckId, ctx: ExitContext & { worktree: string; base: string }): Promise<CheckOutcome> {
  switch (id) {
    case 'branch_has_commits': {
      const ahead = await commitsAhead(ctx.worktree, ctx.base);
      return ahead > 0 ? { met: true, detail: `${ahead} commit(s) ahead of ${ctx.base}` } : { met: false, detail: `No commits ahead of ${ctx.base}` };
    }
    case 'no_coauthor_trailers': {
      const commits = await coAuthoredCommits(ctx.worktree, `${ctx.base}..HEAD`);
      return commits.length === 0 ? { met: true } : { met: false, detail: coAuthoredFix(commits) };
    }
    case 'tree_clean': {
      const changes = await uncommitted(ctx.worktree);
      return changes.length === 0 ? { met: true } : { met: false, detail: `Uncommitted changes:\n${changes.join('\n')}` };
    }
    case 'tests_pass': {
      const { testCommand } = readProjectSettings(ctx.repo);
      if (!testCommand) return { met: false, detail: `No testCommand in ${PROJECT_SETTINGS_FILE}` };
      return commandCheck(testCommand, ctx.worktree);
    }
    case 'findings_exist': {
      if (!ctx.findingsPath) return { met: false, detail: 'This Item has no place for review findings' };
      return (await fileAtHead(ctx.worktree, ctx.findingsPath)) !== undefined
        ? { met: true, detail: ctx.findingsPath }
        : { met: false, detail: `Write the findings to ${ctx.findingsPath} and commit them` };
    }
    case 'grill_record_exists':
      return committed(ctx.worktree, ctx, grillPathOf, 'grill record');
    case 'spec_exists':
      return committed(ctx.worktree, ctx, specPathOf, 'spec');
    case 'artifact_exists': {
      if (!ctx.itemDir) return { met: false, detail: 'This Item has no place for its artifacts' };
      const listed = await git(ctx.worktree, 'ls-tree', '-r', '--name-only', 'HEAD', '--', `${ctx.itemDir}/`).catch(() => '');
      const artifacts = listed.split('\n').map((f) => f.trim()).filter((f) => f && f !== ctx.itemPath);
      return artifacts.length
        ? { met: true, detail: artifacts.join('\n') }
        : { met: false, detail: `Write the Item's artifact into ${ctx.itemDir} and commit it` };
    }
    default: {
      if (!parseModuleCheckId(id)) return { met: false, detail: 'This check needs no worktree' };
      const found = moduleCheckOf(ctx.repo, id);
      if (!found?.check.command) return { met: false, detail: `No module of this Project has the check ${id}` };
      // `{moduleDir}` lets a check run a script its module ships; the env names the same folder and the base.
      // `{tool:<name>}` is the tool's path from Settings, else its name on PATH.
      const command = expandModuleText(found.check.command, found.folder, ctx.toolPaths);
      return commandCheck(command, ctx.worktree, { KILN_MODULE_DIR: found.folder, KILN_BASE: ctx.base });
    }
  }
}

/** Runs a check's command in the worktree: exit code 0 meets it, and its output is the detail. */
async function commandCheck(command: string, worktree: string, env?: Record<string, string>): Promise<CheckOutcome> {
  const { code, output } = await runCommand(command, worktree, env);
  const head = `\`${command}\` exited with ${code ?? 'no code'}`;
  return { met: code === 0, detail: output ? `${head}\n${output}` : head };
}

/** A `module:<module>/<check>` check and its module's folder, from the modules the Project's main checkout pulls in (never the worktree's). */
function moduleCheckOf(repo: string, id: string): { check: ModuleExitCheck; folder: string } | undefined {
  const named = parseModuleCheckId(id);
  if (!named) return undefined;
  const loaded = readProjectFiles(repo).modules.find((m) => m.module.id === named.module);
  const check = loaded?.module.exitChecks?.find((c) => c.id === named.check);
  return loaded && check ? { check, folder: loaded.folder } : undefined;
}

const nameOf = (id: ExitCheckId, repo: string) =>
  NAMES[id as BuiltInExitCheckId] ?? moduleCheckOf(repo, id)?.check.name ?? id;

/**
 * Checks every named check of a Stage's Exit, in order, then (on a Stage with a worktree) the
 * built-in checks the Workflow did not name.
 */
export async function checkExit(stage: string, checks: ExitCheckId[], ctx: ExitContext): Promise<ExitStatus> {
  const builtIn = ctx.worktree && ctx.base ? BUILT_IN_WORKTREE_CHECKS.filter((id) => !checks.includes(id)) : [];
  const results: ExitCheckResult[] = [];
  for (const id of [...checks, ...builtIn]) results.push({ id, name: nameOf(id, ctx.repo), ...(await check(id, ctx)) });
  return { stage, met: results.every((r) => r.met), checks: results, checkedAt: new Date().toISOString() };
}

/** The feedback a Session gets when its Exit is not met. */
export function exitFeedback(exit: ExitStatus): string {
  const missing = exit.checks.filter((c) => !c.met);
  return [
    'Kiln checked the Exit for this Stage and it is not met yet:',
    ...missing.map((c) => `- ${c.name}: ${c.detail ?? 'missing'}`),
    'Fix this, commit your work and leave the working tree clean, then finish again.',
  ].join('\n');
}
