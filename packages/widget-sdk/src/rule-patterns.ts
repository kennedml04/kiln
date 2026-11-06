// The Policy rule a person's "Always allow" saves, and the groups the Permission review proposes
// rules for. A rule is the narrowest prefix that still covers the next request of the same shape:
// the program, its subcommand (and action word, as in `npm run lint` or `gh pr view`), and its
// leading plain flags, then ` *` when more words follow (`git checkout -q *`). Commands whose
// arguments decide what they do to the machine (deleting, killing, running other code) get no
// pattern, and no rule ever names a local folder.
// Browser-safe: pure functions over text.
import type { PolicyAction } from './policy.ts';
import { splitCommands } from './shell-commands.ts';

/** A path under a home folder (Windows, Git Bash or posix spelling): never saved in a rule. */
export const LOCAL_PATH = /[a-z]:[\\/]+(Users|home)[\\/]|\/(Users|home)\//i;

/** Programs whose next word is their subcommand. */
const SUBCOMMAND = new Set(['git', 'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'docker', 'kubectl', 'pip', 'pip3', 'uv', 'dotnet', 'winget', 'brew']);
/** Subcommands whose next word says what they act on (`npm run lint`, `git stash list`, `gh pr view`). */
const ACTION_WORD: Record<string, Set<string> | 'all'> = {
  npm: new Set(['run', 'run-script', 'exec']),
  pnpm: new Set(['run', 'exec']),
  yarn: new Set(['run']),
  bun: new Set(['run']),
  git: new Set(['stash', 'remote', 'config', 'submodule']),
  docker: new Set(['compose']),
  gh: 'all',
};
/** Programs that run the script named next: the script is part of the rule (`node scripts/check.ts`). */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'tsx', 'ts-node', 'ruby', 'perl', 'php']);
/** Interpreter flags that still run a named file, not code from the command line. */
const INTERPRETER_FLAGS = new Set(['--test', '--check']);
/**
 * Programs that get no pattern: those that delete, kill or run other code (their arguments are
 * the whole risk), wrappers, and the readers the shell Policy already judges for itself.
 */
const NO_PATTERN = new Set([
  'rm', 'rmdir', 'del', 'kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'spps', 'sudo', 'su', 'runas',
  'bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh', 'eval', 'exec', 'source', '.', 'xargs', 'env', 'nohup', 'timeout', 'time',
  'curl', 'wget', 'invoke-webrequest', 'iwr', 'cp', 'mv', 'dd', 'chmod', 'chown', 'sed', 'awk', 'cd', 'pushd', 'popd',
  'monitor', 'set-location', 'remove-item', 'ri', 'move-item', 'copy-item',
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'tree', 'file', 'stat', 'du',
  'diff', 'cut', 'basename', 'dirname', 'realpath', 'echo', 'which', 'sleep', 'seq', 'nproc', 'true', 'false', 'date',
  'test', '[', 'jq', 'sort',
]);
/** Git subcommands that rewrite or throw away history, or reach other folders: always asked one by one. */
const GIT_UNPATTERNED = new Set(['reset', 'clean', 'push', 'worktree', 'filter-branch', 'filter-repo', 'update-ref', 'gc', 'prune', 'reflog', 'rm']);
/** Flags that force: a rule with one would allow every forced form. */
const FORCING = /^(?:-[a-zA-Z]*[fD]|--force\b|--hard|--delete|--no-verify)/;
const PROGRAM = /^[\w.+-]+$/;
const PLAIN_WORD = /^[\w.+:@/-]+$/;
const FLAG = /^--?[A-Za-z][\w-]*$/;

/**
 * The prefix rule "Always allow" saves for this request, or undefined when it saves none (the
 * request is then saved as it stands, if at all: see `alwaysAllowMatch`). A rule ends in ` *`
 * when the command has words past its prefix, and is the command itself when it has none.
 */
export function rulePattern(action: PolicyAction, detail: string): string | undefined {
  if (action !== 'other_commands' && action !== 'known_commands') return undefined;
  const parts = splitCommands(detail.trim());
  if (parts.length !== 1 || detail.includes('\n')) return undefined;
  const command = parts[0]!.trim();
  const words = command.split(/\s+/);
  const program = words[0]!;
  if (!PROGRAM.test(program) || NO_PATTERN.has(program.toLowerCase())) return undefined;
  const prefix = [program];
  let i = 1;
  const next = () => words[i];
  if (SUBCOMMAND.has(program)) {
    const sub = next();
    if (!sub || sub.startsWith('-') || !PLAIN_WORD.test(sub)) return undefined;
    if (program === 'git' && GIT_UNPATTERNED.has(sub)) return undefined;
    // `gh api <path>` covers every method on that path, writes included.
    if (program === 'gh' && sub === 'api') return undefined;
    prefix.push(sub);
    i++;
    const actions = ACTION_WORD[program];
    const word = next();
    if (actions && (actions === 'all' || actions.has(sub)) && word && !word.startsWith('-') && PLAIN_WORD.test(word)) {
      prefix.push(word);
      i++;
    }
  } else if (INTERPRETERS.has(program)) {
    const flag = next();
    if (flag && INTERPRETER_FLAGS.has(flag)) {
      prefix.push(flag);
      i++;
    } else {
      // `node -e '...'` runs whatever the next word says: no pattern. A script is named in full.
      if (!flag || flag.startsWith('-') || !PLAIN_WORD.test(flag)) return undefined;
      prefix.push(flag);
      i++;
    }
  }
  while (i < words.length && FLAG.test(words[i]!)) {
    if (FORCING.test(words[i]!)) return undefined;
    prefix.push(words[i]!);
    i++;
  }
  if (words.slice(i).some((w) => FORCING.test(w))) return undefined;
  const rule = i < words.length ? `${prefix.join(' ')} *` : prefix.join(' ');
  return LOCAL_PATH.test(rule) ? undefined : rule;
}

/**
 * What "Always allow" saves as a rule's match: the pattern when there is one, else the request as
 * it stands. Undefined when either would name a local folder: then "Always allow" isn't offered.
 */
export function alwaysAllowMatch(action: PolicyAction, detail: string): string | undefined {
  const match = rulePattern(action, detail) ?? detail;
  return LOCAL_PATH.test(match) ? undefined : match;
}

/** Whether a command kills processes by image name (`taskkill /IM node.exe`, `pkill node`), not by PID. */
export function killsByName(line: string): boolean {
  const piped = /\b(?:pgrep|pidof)\b[^|\n]*\|\s*xargs\s+(?:-\S+\s+)*kill\b|\bget-process\b[^|\n]*\|\s*(?:stop-process|spps)\b/i;
  if (piped.test(line)) return true;
  return splitCommands(line).some((part) => {
    const words = part.trim().replace(/^sudo\s+/, '').split(/\s+/);
    const program = (words[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    const rest = words.slice(1).join(' ');
    if (program === 'pkill' || program === 'killall') return true;
    if (program === 'taskkill') return /(?:^|\s)[-/]{1,2}im\b/i.test(rest);
    if (program === 'stop-process' || program === 'spps') return !/(?:^|\s)-id\b/i.test(rest) && !/^\d/.test(rest);
    if (program === 'kill') return /\$\(\s*(?:pgrep|pidof)\b|`\s*(?:pgrep|pidof)\b/.test(rest);
    return false;
  });
}

/** One answered Permission Ask, as the Permission review reads it. */
export interface AnsweredPermission {
  askId: string;
  action: PolicyAction;
  detail: string;
  /** Whether the person let it run (Allow once or Always allow). */
  allowed: boolean;
}

/** Permission Asks of one shape: the rule that would cover them all. */
export interface PermissionGroup {
  action: PolicyAction;
  match: string;
  askIds: string[];
  details: string[];
  /** Every one of them was allowed. */
  allAllowed: boolean;
}

/** Groups answered Permission Asks by the rule "Always allow" would save for each; those that can't have one are left out. */
export function groupByRule(asks: AnsweredPermission[]): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  for (const ask of asks) {
    const match = alwaysAllowMatch(ask.action, ask.detail);
    if (match === undefined) continue;
    const key = `${ask.action}\n${match}`;
    const group = groups.get(key) ?? { action: ask.action, match, askIds: [], details: [], allAllowed: true };
    group.askIds.push(ask.askId);
    if (!group.details.includes(ask.detail)) group.details.push(ask.detail);
    group.allAllowed &&= ask.allowed;
    groups.set(key, group);
  }
  return [...groups.values()];
}
