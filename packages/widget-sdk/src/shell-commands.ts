// Shell command lines, judged against the Policy. A command that only reads the worktree (`ls`,
// `cat`, `git log`, `grep`, `sed -n`) is the worktree read it is, and one that only changes files in
// it (`git add`, `git commit`, `mkdir`, `cat > file <<'EOF'`) a worktree write, so no Permission Ask
// comes up for an `ls`. Anything this file is unsure of (a redirect, a variable, a path outside the
// worktree, an option that runs another program, deleting with `rm`) stays an ordinary command.
// Browser-safe: paths are compared as text, with no node:path.
import { decide, type EffectivePolicy, type PolicyAction, type PolicyDecision } from './policy.ts';

/** What one shell command line asks for, in Kiln's terms. */
export interface ShellRequest {
  action: PolicyAction;
  detail: string;
  decision: PolicyDecision;
}

/** Splits a shell command line into its commands (on `&&`, `||`, `;`, `|` and newlines), outside quotes. */
export function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) current += line[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Splits one command into words, honouring quotes; undefined when it uses anything this file won't judge. */
function words(command: string): string[] | undefined {
  // Throwing away stderr, or merging it into stdout, writes nothing.
  const line = command.replace(/\s2>&1\b/g, ' ').replace(/\s2>\s*\/dev\/null\b/g, ' ');
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === '$' || c === '`')) return undefined;
      else if (quote === '"' && c === '\\' && i + 1 < line.length) current += line[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    // Redirects, variables, substitutions, background jobs, the home folder: not judged here.
    // (`~` inside a word is a revision, as in `HEAD~3`.)
    if ('<>$`&(){}'.includes(c) || (c === '~' && !started)) return undefined;
    if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += c;
    started = true;
  }
  if (quote) return undefined;
  if (started) out.push(current);
  return out;
}

const DRIVE = /^[a-z]:\//i;

/** An absolute path with `.` and `..` worked out (never above its root). */
function normalise(path: string): string {
  const [head, ...rest] = path.split('/');
  const out: string[] = [];
  for (const part of rest) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `${head}/${out.join('/')}`;
}

/**
 * Whether an operand stays inside the worktree. On a worktree with a drive letter, a Git Bash
 * `/c/...` path counts as `C:/...` and case does not matter.
 */
export function staysInside(worktree: string, word: string): boolean {
  const root = worktree.split('\\').join('/');
  const windows = DRIVE.test(root);
  let path = word.split('\\').join('/');
  if (windows) path = path.replace(/^\/([a-z])(\/|$)/i, '$1:/');
  if (/^[a-z]:(?!\/)/i.test(path)) return false;
  const absolute = path.startsWith('/') || DRIVE.test(path);
  const fold = (p: string) => (windows ? p.toLowerCase() : p);
  const base = normalise(root);
  const target = normalise(absolute ? path : `${root}/${path}`);
  const b = fold(base).replace(/\/$/, '');
  const t = fold(target).replace(/\/$/, '');
  return t === b || t.startsWith(`${b}/`);
}

const flag = (w: string) => w.startsWith('-') && w !== '-';
const has = (args: string[], ...bad: string[]) => args.some((a) => bad.some((b) => a === b || a.startsWith(`${b}=`)));

/** Programs that only read, each with the options that would make it write or run something else. */
const PLAIN: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  dir: () => true,
  pwd: () => true,
  cat: () => true,
  head: () => true,
  tail: (a) => !has(a, '-f', '-F', '--follow'),
  wc: () => true,
  grep: () => true,
  egrep: () => true,
  fgrep: () => true,
  rg: (a) => !has(a, '--pre', '--pre-glob'),
  find: (a) => !has(a, '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'),
  tree: (a) => !has(a, '-o'),
  file: () => true,
  stat: () => true,
  du: () => true,
  diff: () => true,
  cut: () => true,
  basename: () => true,
  dirname: () => true,
  realpath: () => true,
  echo: () => true,
  which: () => true,
  sort: (a) => !a.some((w) => w === '-o' || w.startsWith('--output') || /^-[a-z]*o/i.test(w)),
  // Print lines only: `-n` with an address-and-print script, never `-i` or a `w`/`e` command.
  sed: (a) => a.includes('-n') && !a.some((w) => /^-[a-z]*i/.test(w) || w.startsWith('--in-place')) && a.filter((w) => !flag(w)).length > 0 && /^[\d,$]+p$|^\/[^/]*\/p$/.test(a.find((w) => !flag(w))!),
};

/** Git subcommands that only read, with the options that would make them write or run something. */
const GIT: Record<string, (args: string[]) => boolean> = {
  status: () => true,
  log: () => true,
  diff: () => true,
  show: () => true,
  'ls-tree': () => true,
  'ls-files': () => true,
  'rev-parse': () => true,
  'rev-list': () => true,
  'merge-base': () => true,
  blame: () => true,
  describe: () => true,
  shortlog: () => true,
  'cat-file': () => true,
  'show-ref': () => true,
  grep: (a) => !has(a, '-O', '--open-files-in-pager'),
  // Listing only: a bare name would create a branch, unless `--list` makes it a pattern.
  branch: (a) => (a.every((w) => flag(w)) || a.includes('--list') || a.includes('-l')) && !a.some((w) => /^-[a-z]*[dDmMcCf]/.test(w) || ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description'].some((b) => w.startsWith(b))),
  tag: (a) => a.length === 0 || a.every((w) => w === '-l' || w === '--list'),
  remote: (a) => a.length === 0 || a.every((w) => w === '-v' || w === '--verbose'),
  worktree: (a) => a[0] === 'list',
  stash: (a) => a[0] === 'list',
  config: (a) => ['--get', '--get-all', '--list', '-l'].includes(a[0] ?? '') && a.length <= 2,
};

/** PowerShell's reading cmdlets (and their aliases). */
const POWERSHELL = new Set(['get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'test-path', 'resolve-path', 'get-item', 'gi', 'measure-object']);

/** Git subcommands that only change the worktree, its index or its branch. */
const GIT_WRITES: Record<string, (args: string[]) => boolean> = {
  add: () => true,
  // Hooks run as for a person: a commit that skips them is not judged here.
  commit: (a) => !has(a, '--no-verify', '-n'),
  restore: () => true,
  rm: () => true,
  mv: () => true,
  // Files only (`git checkout -- <path>`, `--ours`/`--theirs`), never a branch switch.
  checkout: (a) => a.includes('--') || a.some((w) => w === '--ours' || w === '--theirs'),
};

/** File commands whose every operand stays in the worktree. */
const FILE_WRITES: Record<string, (args: string[]) => boolean> = {
  mkdir: () => true,
  touch: () => true,
  cp: () => true,
  mv: () => true,
};

/**
 * Takes out the body of every heredoc whose delimiter is quoted (`<<'EOF'`, `<<"EOF"`): the shell
 * expands nothing in it, so it is data, not commands. An unquoted heredoc is left as it is.
 */
export function withoutQuotedHeredocs(line: string): string {
  const lines = line.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    out.push(text);
    const opened = /<<-?\s*(['"])(\w+)\1/.exec(text);
    if (!opened) continue;
    const end = opened[2]!;
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== end) i++;
    i++;
  }
  return out.join('\n');
}

/**
 * Whether one shell command (already split from its line on `&&`, `|`, `;`) only reads inside
 * `worktree`. `cd` into the worktree or a folder in it counts, since it changes nothing.
 */
export function isReadOnlyCommand(command: string, worktree: string): boolean {
  const all = words(command);
  if (!all?.length) return false;
  const [program, ...args] = all;
  const name = program!.toLowerCase();
  // Writing options that every program shares.
  if (args.some((a) => a.startsWith('--output'))) return false;
  const operands = (list: string[]) => list.filter((w) => !flag(w));
  const pathsInside = (list: string[]) => operands(list).every((w) => staysInside(worktree, w));

  // A bare `cd` goes to the home folder, and the commands after it would read there.
  if (name === 'cd') return args.length === 1 && pathsInside(args);
  if (name === 'git') {
    let rest = args;
    // `git -C <folder>` in the worktree and `--no-pager`; any other option before the subcommand
    // (`-c`, `--exec-path`) is not judged.
    while (rest[0] === '--no-pager' || (rest[0] === '-C' && rest[1] !== undefined)) {
      if (rest[0] === '--no-pager') {
        rest = rest.slice(1);
        continue;
      }
      if (!staysInside(worktree, rest[1]!)) return false;
      rest = rest.slice(2);
    }
    // `--no-index` compares files anywhere on disk.
    if (rest.includes('--no-index')) return false;
    const [sub, ...subArgs] = rest;
    if (!sub || flag(sub)) return false;
    const check = GIT[sub];
    // A revision such as `main:.scratch/x.md` is not a path; paths after `--` are.
    const dashes = subArgs.indexOf('--');
    return !!check && check(subArgs) && (dashes < 0 || pathsInside(subArgs.slice(dashes + 1)));
  }
  if (POWERSHELL.has(name)) return pathsInside(args.filter((a) => !/^-[a-z]+$/i.test(a)));
  const check = PLAIN[name];
  if (!check || !check(args)) return false;
  if (name === 'echo') return true;
  // grep and sed take a pattern or script first; only what follows names files.
  const files = ['grep', 'egrep', 'fgrep', 'rg', 'sed'].includes(name) ? operands(args).slice(1) : operands(args);
  if (name === 'find') return files.slice(0, 1).every((w) => staysInside(worktree, w));
  return files.every((w) => staysInside(worktree, w));
}

/**
 * What one shell command (already split from its line) does to `worktree`: `read` (it only reads
 * inside it; `cd` into it counts), `write` (it only changes files in it, its index or its branch),
 * or undefined when this file can't tell, so the Policy treats it as a command.
 */
export function worktreeEffect(command: string, worktree: string): 'read' | 'write' | undefined {
  if (isReadOnlyCommand(command, worktree)) return 'read';
  // `cat > <file> <<'EOF'` (its body already taken out) writes that one file.
  const heredoc = /^cat\s*>>?\s*("[^"$`]+"|'[^']+'|[^\s'"$`<>]+)\s*<<-?\s*(['"])\w+\2\s*$/.exec(command);
  if (heredoc) return staysInside(worktree, heredoc[1]!.replace(/^["']|["']$/g, '')) ? 'write' : undefined;
  const all = words(command);
  if (!all?.length) return undefined;
  const [program, ...args] = all;
  const operands = args.filter((w) => !flag(w));
  if (program === 'git') {
    const [sub, ...subArgs] = args;
    const check = sub ? GIT_WRITES[sub] : undefined;
    if (!check || !check(subArgs)) return undefined;
    // A commit's message is not a path; every other operand is.
    if (sub === 'commit') return 'write';
    return subArgs.filter((w) => !flag(w)).every((w) => staysInside(worktree, w)) ? 'write' : undefined;
  }
  const check = FILE_WRITES[program!];
  return check && check(args) && operands.length > 0 && operands.every((w) => staysInside(worktree, w)) ? 'write' : undefined;
}

const EXTERNAL_WRITES = [/^git\s+push\b/, /^gh\s+(pr|issue)\s+(create|comment|edit|close|merge|review)\b/, /^gh\s+release\s+create\b/, /^gh\s+api\b.*-X\s*(POST|PUT|PATCH|DELETE)/i];

const isKnown = (command: string, known: string[]) =>
  known.some((k) => (k.endsWith('*') ? command.startsWith(k.slice(0, -1)) : command === k));

/**
 * One shell command's action. A worktree read or write counts as one, unless a rule names it as a
 * command (an Org rule that denies `cat secrets*` still holds).
 */
function commandRequest(policy: EffectivePolicy, worktree: string, command: string): ShellRequest {
  const ruled = decide(policy, 'other_commands', command) !== policy.actions.other_commands;
  const effect = ruled ? undefined : worktreeEffect(command, worktree);
  if (effect) {
    const action: PolicyAction = effect === 'read' ? 'worktree_read' : 'worktree_write';
    return { action, detail: command, decision: decide(policy, action, command) };
  }
  const action: PolicyAction = EXTERNAL_WRITES.some((re) => re.test(command))
    ? 'external_writes'
    : isKnown(command, policy.knownCommands)
      ? 'known_commands'
      : 'other_commands';
  return { action, detail: command, decision: decide(policy, action, command) };
}

const RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** What a shell command line (Bash or PowerShell) run in `worktree` amounts to, and the Policy's word on it. */
export function shellRequest(policy: EffectivePolicy, worktree: string, line: string): ShellRequest {
  // Kiln never commits a Co-Authored-By trailer. The core refuses one in a Permission Ask; this
  // catches the commands the Policy allows without asking. (A `grep` for trailers is fine: only
  // lines that commit, merge or write to GitHub are refused.)
  if (/co-authored-by/i.test(line) && /\bgit\s+(commit|merge|tag|notes|rebase|cherry-pick|commit-tree)\b|\bgh\s+(pr|issue|release)\b/.test(line)) {
    return { action: 'other_commands', detail: `${line}\n(Kiln never commits a Co-Authored-By trailer: run it again without one, and add no attribution lines)`, decision: 'deny' };
  }
  // A quoted heredoc's body is data; the command that opens it is judged.
  const stripped = withoutQuotedHeredocs(line);
  const commands = splitCommands(stripped);
  if (!commands.length) return { action: 'other_commands', detail: '', decision: decide(policy, 'other_commands', '') };
  // The strictest of its commands decides, and is the one a Permission Ask names.
  const strictest = commands.map((c) => commandRequest(policy, worktree, c)).reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  // A person asked about `python - <<'EOF'` sees the script too.
  return strictest.decision === 'ask' && stripped !== line && /<<-?\s*['"]/.test(strictest.detail) ? { ...strictest, detail: line } : strictest;
}
