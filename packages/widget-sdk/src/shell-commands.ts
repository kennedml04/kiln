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
      // A variable or substitution; a `$` before the closing quote or a space is just a dollar sign.
      else if (quote === '"' && (c === '`' || (c === '$' && /[\w{(@*#?$!-]/.test(line[i + 1] ?? '')))) return undefined;
      // In double quotes a backslash escapes only `$`, a backquote, `"`, `\` and a newline.
      else if (quote === '"' && c === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) current += line[++i];
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

/**
 * Whether an operand stays inside the worktree or names a path in one of the `scratch` folders (the
 * temp folder: `/tmp`, and the system's, where Claude Code keeps background task output). A
 * relative path is always the worktree's.
 */
function reaches(worktree: string, scratch: string[], word: string): boolean {
  if (staysInside(worktree, word)) return true;
  const path = word.split('\\').join('/');
  const absolute = path.startsWith('/') || DRIVE.test(path);
  return absolute && scratch.some((root) => staysInside(root, path));
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
  sleep: () => true,
  nproc: () => true,
  true: () => true,
  false: () => true,
  date: (a) => !has(a, '-s', '--set'),
  // `[ -s file ]`, `test -f file`: only looks.
  test: () => true,
  '[': () => true,
  jq: (a) => !has(a, '--rawfile', '--slurpfile'),
  sort: (a) => !a.some((w) => w === '-o' || w.startsWith('--output') || /^-[a-z]*o/i.test(w)),
  // Prints to stdout only: no `-i`, and a script that reads no other file and writes or runs nothing.
  sed: (a) => !sedInPlace(a) && sedParts(a) !== undefined,
};

const sedInPlace = (args: string[]) => args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'));

/**
 * Whether a sed script only selects, deletes, prints and substitutes lines: addresses (`12`, `$`,
 * `/re/`, `0,/re/`), then `p`, `d`, `=`, `q`, or `s` with any delimiter and only the `g`, `p`, `i`,
 * `I`, `m`, `M` or number flags. `w`, `r`, `e` and every other command are not judged here.
 */
export function isPlainSedScript(script: string): boolean {
  let i = 0;
  const n = script.length;
  const skipRegex = (d: string) => {
    for (i++; i < n && script[i] !== d; i++) if (script[i] === '\\') i++;
    if (i >= n) return false;
    i++;
    return true;
  };
  const address = () => {
    if (/\d/.test(script[i] ?? '')) while (/\d/.test(script[i] ?? '')) i++;
    else if (script[i] === '$') i++;
    else if (script[i] === '/') return skipRegex('/');
    return true;
  };
  let commands = 0;
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i]!)) i++;
    if (i >= n) break;
    if (!address()) return false;
    if (script[i] === ',') {
      i++;
      if (!address()) return false;
    }
    while (script[i] === ' ' || script[i] === '!') i++;
    const c = script[i];
    if (c === 'p' || c === 'd' || c === '=' || c === 'q') i++;
    else if (c === 's') {
      const d = script[++i];
      if (!d || /[\s\\\n]/.test(d)) return false;
      if (!skipRegex(d)) return false;
      i--;
      if (!skipRegex(d)) return false;
      while (/[gpiImM\d]/.test(script[i] ?? '')) i++;
    } else return false;
    while (script[i] === ' ') i++;
    if (i < n && script[i] !== ';' && script[i] !== '\n') return false;
    commands++;
  }
  return commands > 0;
}

/** Whether a command has a backslash outside quotes, which the shell would take out before sed sees it. */
function bareBackslash(command: string): boolean {
  let quote: string | null = null;
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') return true;
  }
  return false;
}

/** A sed command's files, when every script in it is plain (see isPlainSedScript); else undefined. */
function sedParts(args: string[]): string[] | undefined {
  const scripts: string[] = [];
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    if (w === '-e' || w === '--expression') scripts.push(args[++k] ?? '');
    else if (w.startsWith('--expression=')) scripts.push(w.slice('--expression='.length));
    else if (w === '-f' || w.startsWith('--file')) return undefined;
    else if (flag(w)) {
      if (!/^-[nErsuz]*(i[\w.]*)?$/.test(w) && !w.startsWith('--in-place') && !['--regexp-extended', '--quiet', '--silent', '--posix'].includes(w)) return undefined;
    } else files.push(w);
  }
  if (!scripts.length) {
    const first = files.shift();
    if (first === undefined) return undefined;
    scripts.push(first);
  }
  return scripts.every(isPlainSedScript) ? files : undefined;
}

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
const POWERSHELL = new Set(['get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'test-path', 'resolve-path', 'get-item', 'gi', 'measure-object', 'select-object', 'select', 'sort-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string']);

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
  // Finishing or dropping a rebase or merge already under way.
  rebase: (a) => a.length === 1 && ['--continue', '--abort', '--skip'].includes(a[0]!),
  // Merging a branch into this one; its operands are branch names, and hooks still run.
  merge: (a) => !has(a, '--no-verify', '-s', '--strategy', '-X', '--strategy-option'),
  stash: (a) => a.length === 0 || ['push', 'pop', 'apply', 'drop'].includes(a[0]!),
};
/** Git writes whose operands are revisions or messages, not paths. */
const GIT_NO_PATHS = new Set(['commit', 'rebase', 'merge', 'stash']);

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
export function isReadOnlyCommand(command: string, worktree: string, scratch: string[] = []): boolean {
  // `echo` only prints, variables (`$?`, `$x`) included: only a redirect or a substitution does more.
  if (/^echo(\s|$)/.test(command) && !/[<>`]|\$\(/.test(command)) return true;
  const all = words(command);
  if (!all?.length) return false;
  const [program, ...args] = all;
  const name = program!.toLowerCase();
  // Writing options that every program shares.
  if (args.some((a) => a.startsWith('--output'))) return false;
  const operands = (list: string[]) => list.filter((w) => !flag(w));
  const ok = (w: string) => reaches(worktree, scratch, w);
  // `cd` and `git -C` change where later commands run, so only the worktree counts there.
  const pathsInside = (list: string[]) => operands(list).every(ok);

  // A bare `cd` goes to the home folder, and the commands after it would read there.
  if (name === 'cd') return args.length === 1 && !flag(args[0]!) && staysInside(worktree, args[0]!);
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
  if (name === 'sed') return !bareBackslash(command) && sedParts(args)!.every(ok);
  // grep takes a pattern first; only what follows names files.
  let files = ['grep', 'egrep', 'fgrep', 'rg'].includes(name) ? operands(args).slice(1) : operands(args);
  if (name === 'find') return files.slice(0, 1).every(ok);
  if (name === 'jq') files = files.slice(1);
  // `[ -s file ]`: the brackets and `!` are not paths, nor are the words after `=`, `-eq`, ...
  if (name === 'test' || name === '[') files = files.filter((w) => w !== ']' && w !== '!' && w !== '=' && w !== '!=');
  if (name === 'sleep' || name === 'date' || name === 'nproc' || name === 'true' || name === 'false') return true;
  return files.every(ok);
}

/** Environment settings that change nothing a command could do to the computer. */
const SAFE_ENV = /^(?:GIT_EDITOR=(?:true|:)|GIT_PAGER=cat|PAGER=cat|CI=(?:1|true)|NO_COLOR=1|FORCE_COLOR=0)\s+/;
/** Shell words that only shape a loop or a branch: nothing to judge on their own. */
const SHAPE = new Set(['', 'do', 'done', 'then', 'else', 'fi', '{', '}', 'esac']);

/**
 * One command with what only wraps it taken off: a subshell's or group's brackets left at its ends
 * by the split, `timeout N`, `time`, a background `&`, a loop's or branch's keyword (`do`, `until`,
 * `if`), PowerShell's `if ($?) { ... }`, and the harmless environment settings in SAFE_ENV.
 */
export function unwrap(command: string): string {
  let c = command.trim();
  for (let prev = ''; prev !== c; ) {
    prev = c;
    c = c
      .replace(/^if\s*\(\s*\$\?\s*\)\s*\{\s*/i, '')
      .replace(/^[({]\s*/, '')
      .replace(/\s*[)}]$/, '')
      .replace(/\s+&$/, '')
      .replace(/^(?:do|then|else|elif|until|while|if|!)\s+/, '')
      .replace(/^time\s+/, '')
      .replace(/^timeout\s+(?:(?:-[sk]|--signal|--kill-after)[\s=]\S+\s+|--\w[\w-]*\s+)*\d+(?:\.\d+)?[smhd]?\s+/, '')
      .replace(SAFE_ENV, '')
      .trim();
  }
  return c;
}

/**
 * Takes out the output redirects of a command (`> file`, `>> file`, `2> file`, `&> file`) whose
 * target this file can judge, and a quoted heredoc's opener (its body is already gone). `wrote`
 * says whether a redirect wrote a file; `ok` is false when a target is outside the worktree and the
 * scratch folders, and the command is left for the Policy.
 */
function withoutRedirects(command: string, worktree: string, scratch: string[]): { command: string; wrote: boolean; ok: boolean } {
  let wrote = false;
  let ok = true;
  const out = command
    .replace(/\s*<<-?\s*(['"])\w+\1/g, '')
    .replace(/(^|\s)(?:[12]|&)?>>?\s*("[^"$`]+"|'[^']+'|[^\s'"$`<>|&;()]+)/g, (whole, lead: string, target: string) => {
      const path = target.replace(/^["']|["']$/g, '');
      if (path === '/dev/null' || /^&[12]$/.test(path)) return lead;
      if (!reaches(worktree, scratch, path)) {
        ok = false;
        return whole;
      }
      wrote = true;
      return lead;
    })
    .trim();
  return { command: out, wrote, ok };
}

/**
 * The command a Policy rule is matched against and the shell effect is judged on: unwrapped, with
 * redirects into the worktree or scratch taken out (see unwrap, withoutRedirects).
 */
function reduce(command: string, worktree: string, scratch: string[]): { command: string; wrote: boolean } {
  let c = unwrap(command);
  let wrote = false;
  for (let prev = ''; prev !== c; ) {
    prev = c;
    const r = withoutRedirects(c, worktree, scratch);
    if (!r.ok) return { command: c, wrote: false };
    wrote ||= r.wrote;
    c = unwrap(r.command);
  }
  return { command: c, wrote };
}

/**
 * What one shell command (already split from its line) does to `worktree`: `read` (it only reads
 * inside it; `cd` into it counts), `write` (it only changes files in it, its index or its branch),
 * or undefined when this file can't tell, so the Policy treats it as a command.
 */
export function worktreeEffect(command: string, worktree: string, scratch: string[] = []): 'read' | 'write' | undefined {
  const { command: bare, wrote } = reduce(command, worktree, scratch);
  // A loop's or branch's own keywords (`done`, `fi`) and a `for` header over plain words do nothing.
  if (SHAPE.has(bare) || (/^for\s+\w+\s+in\b/.test(bare) && words(bare) !== undefined)) return 'read';
  const effect = bareEffect(bare, worktree, scratch);
  return effect && wrote ? 'write' : effect;
}

function bareEffect(command: string, worktree: string, scratch: string[]): 'read' | 'write' | undefined {
  if (isReadOnlyCommand(command, worktree, scratch)) return 'read';
  const ok = (w: string) => reaches(worktree, scratch, w);
  const all = words(command);
  if (!all?.length) return undefined;
  const [program, ...args] = all;
  const operands = args.filter((w) => !flag(w));
  if (program === 'git') {
    const [sub, ...subArgs] = args;
    const check = sub ? GIT_WRITES[sub] : undefined;
    if (!check || !check(subArgs)) return undefined;
    // A commit's message, or a branch to merge, is not a path; every other operand is.
    if (GIT_NO_PATHS.has(sub!)) return 'write';
    return subArgs.filter((w) => !flag(w)).every((w) => staysInside(worktree, w)) ? 'write' : undefined;
  }
  // `sed -i` with a plain script edits the files it names, and nothing else.
  if (program === 'sed' && sedInPlace(args) && !bareBackslash(command)) {
    const files = sedParts(args);
    return files?.length && files.every(ok) ? 'write' : undefined;
  }
  const check = FILE_WRITES[program!];
  return check && check(args) && operands.length > 0 && operands.every(ok) ? 'write' : undefined;
}

/**
 * A `for <name> in <words>` header's variable and its values, when every value is a plain word.
 * The loop's body is judged once for each value, so `cat "$f"` reads the files it lists.
 */
function loopVariables(commands: string[]): Map<string, string[]> {
  const vars = new Map<string, string[]>();
  for (const c of commands) {
    const m = /^for\s+(\w+)\s+in\s+(.*)$/.exec(unwrap(c));
    const values = m ? words(m[2]!) : undefined;
    if (m && values?.length) vars.set(m[1]!, values);
  }
  return vars;
}

/** The command once for each value of each loop variable it uses (`$f`, `"$f"`, `${f}`). */
function expand(command: string, vars: Map<string, string[]>): string[] {
  let out = [command];
  for (const [name, values] of vars) {
    const use = new RegExp(`"?\\$(?:\\{${name}\\}|${name}\\b)"?`, 'g');
    if (!use.test(command)) continue;
    out = out.flatMap((c) => values.map((v) => c.replace(use, `'${v.replace(/'/g, '')}'`)));
  }
  return out;
}

const EXTERNAL_WRITES = [/^git\s+push\b/, /^gh\s+(pr|issue)\s+(create|comment|edit|close|merge|review)\b/, /^gh\s+release\s+create\b/, /^gh\s+api\b.*-X\s*(POST|PUT|PATCH|DELETE)/i];

const isKnown = (command: string, known: string[]) =>
  known.some((k) => (k.endsWith('*') ? command.startsWith(k.slice(0, -1)) : command === k));

/**
 * One shell command's action. A worktree read or write counts as one, unless a rule names it as a
 * command (an Org rule that denies `cat secrets*` still holds).
 */
function commandRequest(policy: EffectivePolicy, worktree: string, command: string, scratch: string[], judged = command): ShellRequest {
  // Rules match the command without its wrapping (`timeout 120 npm test` is `npm test`).
  const bare = reduce(judged, worktree, scratch).command;
  const ruled = [judged, bare].map((c) => decide(policy, 'other_commands', c)).filter((d) => d !== policy.actions.other_commands);
  if (ruled.length) return { action: 'other_commands', detail: command, decision: strictestOf(...ruled) };
  const effect = worktreeEffect(judged, worktree, scratch);
  if (effect) {
    const action: PolicyAction = effect === 'read' ? 'worktree_read' : 'worktree_write';
    return { action, detail: command, decision: decide(policy, action, command) };
  }
  const action: PolicyAction = EXTERNAL_WRITES.some((re) => re.test(bare) || re.test(judged))
    ? 'external_writes'
    : isKnown(bare, policy.knownCommands) || isKnown(judged, policy.knownCommands)
      ? 'known_commands'
      : 'other_commands';
  return { action, detail: command, decision: decide(policy, action, action === 'other_commands' ? command : bare) };
}

const strictestOf = (...decisions: PolicyDecision[]) => decisions.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));

const RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** What a shell command line (Bash or PowerShell) run in `worktree` amounts to, and the Policy's word on it. */
export function shellRequest(policy: EffectivePolicy, worktree: string, line: string, scratch: string[] = []): ShellRequest {
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
  const vars = loopVariables(commands);
  const strictest = commands
    .flatMap((c) => expand(c, vars).map((judged) => commandRequest(policy, worktree, c, scratch, judged)))
    .reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  // A person asked about `python - <<'EOF'` sees the script too.
  return strictest.decision === 'ask' && stripped !== line && /<<-?\s*['"]/.test(strictest.detail) ? { ...strictest, detail: line } : strictest;
}
