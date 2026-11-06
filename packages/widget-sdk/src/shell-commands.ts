// Shell command lines, judged against the Policy. A command that only reads the worktree (`ls`,
// `cat`, `git log`, `grep`, `sed -n`) is the worktree read it is, and one that only changes files in
// it (`git add`, `git commit`, `git checkout`, `mkdir`, `rm <file>`, `cat > file <<'EOF'`) a worktree
// write, so no Permission Ask comes up for an `ls`. Anything this file is unsure of (a redirect, a
// variable it can't follow, a path outside the worktree, an option that runs another program,
// deleting a folder) stays an ordinary command. Relative paths are judged from the folder the
// command runs in: the shell's folder, then wherever a `cd` in the line went.
// Browser-safe: paths are compared as text, with no node:path.
import { decide, type EffectivePolicy, type PolicyAction, type PolicyDecision } from './policy.ts';

/** What one shell command line asks for, in Kiln's terms. */
export interface ShellRequest {
  action: PolicyAction;
  detail: string;
  decision: PolicyDecision;
}

/**
 * Where a command line runs, beyond its worktree. `cwd` is the folder the shell stands in (the
 * worktree when not given); `readRoots` are folders the command may read but not write (the
 * Session's own Claude Code folder, with its saved tool results).
 */
export interface ShellPlace {
  cwd?: string;
  readRoots?: string[];
}

/** One command between separators, and the separator after it (`&&`, `||`, `;`, `|`, a newline, or '' at the end). */
interface Part {
  text: string;
  sep: string;
}

/** Splits a line into its commands and the separators between them, outside quotes and `$(...)`. */
function splitParts(line: string): Part[] {
  const parts: Part[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  const end = (sep: string) => {
    parts.push({ text: current.trim(), sep });
    current = '';
  };
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
    // A substitution's own commands belong to it: `f=$(ls; pwd)` is one command.
    if (c === '$' && line[i + 1] === '(') {
      depth++;
      current += '$(';
      i++;
      continue;
    }
    if (depth) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      current += c;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      end(two);
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      end(c);
      continue;
    }
    current += c;
  }
  end('');
  return parts.filter((p) => p.text);
}

/** Splits a shell command line into its commands (on `&&`, `||`, `;`, `|` and newlines), outside quotes and `$(...)`. */
export function splitCommands(line: string): string[] {
  return splitParts(line).map((p) => p.text);
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
const slash = (path: string) => path.split('\\').join('/');
const isAbsolute = (path: string) => path.startsWith('/') || /^[a-z]:/i.test(path);

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
 * Whether an operand stays inside the worktree, a relative one read from `cwd` (the worktree when
 * not given). On a worktree with a drive letter, a Git Bash `/c/...` path counts as `C:/...` and
 * case does not matter.
 */
export function staysInside(worktree: string, word: string, cwd = worktree): boolean {
  const root = slash(worktree);
  const windows = DRIVE.test(root);
  const gitBash = (p: string) => (windows ? p.replace(/^\/([a-z])(\/|$)/i, '$1:/') : p);
  const path = gitBash(slash(word));
  if (/^[a-z]:(?!\/)/i.test(path)) return false;
  const absolute = path.startsWith('/') || DRIVE.test(path);
  const fold = (p: string) => (windows ? p.toLowerCase() : p);
  const base = normalise(root);
  const target = normalise(absolute ? path : `${gitBash(slash(cwd))}/${path}`);
  const b = fold(base).replace(/\/$/, '');
  const t = fold(target).replace(/\/$/, '');
  return t === b || t.startsWith(`${b}/`);
}

/**
 * Where one command is judged: its worktree, every folder it might run in (more than one when a
 * `cd` before it might not have run), the scratch folders it may read and write, and the folders
 * it may only read.
 */
interface Place {
  worktree: string;
  cwds: string[];
  scratch: string[];
  readRoots: string[];
}

const placeOf = (worktree: string, scratch: string[], where: ShellPlace = {}): Place => ({
  worktree,
  cwds: [where.cwd ?? worktree],
  scratch,
  readRoots: where.readRoots ?? [],
});

/** A folder no command is judged from: a `cd` this file can't follow (`cd`, `cd -`, `cd "$x"`) goes there. */
const UNKNOWN_FOLDER = '/:unknown';

/** Whether every folder the command might run in is the worktree or a folder in it. */
const standsInside = (p: Place) => p.cwds.every((c) => staysInside(p.worktree, c));

/** Whether an operand stays inside the worktree from every folder the command might run in. */
const inside = (p: Place, word: string) => standsInside(p) && p.cwds.every((c) => staysInside(p.worktree, word, c));

/**
 * Whether an operand stays inside the worktree or names a path in one of `roots` (by default the
 * scratch folders: `/tmp`, and the system's temp folder, where Claude Code keeps background task
 * output). A relative path is always the worktree's.
 */
function reaches(p: Place, word: string, roots = p.scratch): boolean {
  if (inside(p, word)) return true;
  const path = slash(word);
  return isAbsolute(path) && roots.some((root) => staysInside(root, path));
}

/** Whether a command may read an operand: in the worktree, the scratch folders or a read root (or `/dev/null`, which is empty). */
const readable = (p: Place, word: string) => word === '/dev/null' || reaches(p, word, [...p.scratch, ...p.readRoots]);

/** A path from `cwd`: the path itself when it is absolute. */
const from = (cwd: string, path: string) => (isAbsolute(slash(path)) ? slash(path) : `${slash(cwd)}/${slash(path)}`);

/**
 * Whether a path might name a `.git` (the repo's own data, or a worktree's link to it): a segment
 * that is `.git`, or a glob that could match it. Writing there is never a plain worktree write.
 */
function touchesGit(word: string): boolean {
  return slash(word)
    .split('/')
    .some((segment) => {
      if (segment.toLowerCase() === '.git') return true;
      if (!/[*?[]/.test(segment)) return false;
      const pattern = segment
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
        .replace(/\[!/g, '[^');
      try {
        return new RegExp(`^${pattern}$`, 'i').test('.git');
      } catch {
        return true;
      }
    });
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
  seq: () => true,
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
/** Reading programs whose operands are not paths. */
const NO_PATHS = new Set(['sleep', 'seq', 'date', 'nproc', 'true', 'false']);

const sedInPlace = (args: string[]) => args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'));

/**
 * Whether a sed script only selects, edits and prints lines: addresses (`12`, `$`, `/re/`, `\%re%`,
 * `1~2`, `0,/re/`, `/re/,+2`), blocks (`{ ... }`), then commands that read no file and write or run
 * nothing: `p`, `d`, `=`, `q`, `n`, `N`, `D`, `P`, `h`, `H`, `g`, `G`, `x`, `l`, `z`, `F`, the
 * text commands `a`, `i` and `c`, labels and branches (`:a`, `b`, `t`, `T`), `y`, and `s` with any
 * delimiter and only the `g`, `p`, `i`, `I`, `m`, `M` or number flags. `w`, `W`, `r`, `R`, `e` (and
 * the `w` and `e` flags of `s`) are not judged here.
 */
export function isPlainSedScript(script: string): boolean {
  let i = 0;
  const n = script.length;
  const at = (re: RegExp) => re.test(script[i] ?? '');
  const skipRegex = (d: string) => {
    for (i++; i < n && script[i] !== d; i++) if (script[i] === '\\') i++;
    if (i >= n) return false;
    i++;
    return true;
  };
  const number = () => {
    const start = i;
    while (at(/\d/)) i++;
    return i > start;
  };
  const address = () => {
    if (number()) {
      if (script[i] === '~') {
        i++;
        return number();
      }
    } else if (script[i] === '$') i++;
    else if (script[i] === '/' || script[i] === '\\') {
      const d = script[i] === '\\' ? script[++i] : '/';
      if (!d || /[\s\\]/.test(d) || !skipRegex(d)) return false;
      while (at(/[IM]/)) i++;
    }
    return true;
  };
  // A text command's text: the rest of the line, going on past a backslash-newline.
  const text = () => {
    while (i < n && script[i] !== '\n') i += script[i] === '\\' ? 2 : 1;
  };
  const label = () => {
    const start = i;
    while (i < n && !/[;\n}]/.test(script[i]!)) i++;
    return i > start;
  };
  let commands = 0;
  let depth = 0;
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i]!)) i++;
    if (i >= n) break;
    if (script[i] === '}') {
      if (!depth) return false;
      depth--;
      i++;
      continue;
    }
    if (!address()) return false;
    if (script[i] === ',') {
      i++;
      if (script[i] === '+' || script[i] === '~') {
        i++;
        if (!number()) return false;
      } else if (!address()) return false;
    }
    while (script[i] === ' ' || script[i] === '!') i++;
    const c = script[i] ?? '';
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c && 'pdDnNPhHgGxlzF='.includes(c)) {
      i++;
      if (c === 'l') number();
    } else if (c === 'q' || c === 'Q') {
      i++;
      while (script[i] === ' ') i++;
      number();
    } else if (c === 'a' || c === 'i' || c === 'c') {
      i++;
      text();
    } else if (c === ':') {
      i++;
      if (!label()) return false;
    } else if (c === 'b' || c === 't' || c === 'T') {
      i++;
      while (script[i] === ' ') i++;
      label();
    } else if (c === 's' || c === 'y') {
      const d = script[++i];
      if (!d || /[\s\\\n]/.test(d)) return false;
      if (!skipRegex(d)) return false;
      i--;
      if (!skipRegex(d)) return false;
      if (c === 's') while (at(/[gpiImM\d]/)) i++;
    } else return false;
    while (script[i] === ' ') i++;
    if (i < n && !';\n}'.includes(script[i]!)) return false;
    commands++;
  }
  return commands > 0 && depth === 0;
}

/** Whether a command has a backslash outside quotes, which the shell would take out before sed sees it. */
function bareBackslash(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      // In double quotes a backslash escapes the next character (`\"` does not close the quote).
      else if (quote === '"' && c === '\\') i++;
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

/** `git branch` options that make it list the branches they filter. */
const BRANCH_FILTERS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];

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
  // Listing only: a bare name would create a branch, unless `--list` or a filter makes it a pattern.
  branch: (a) =>
    (a.every((w) => flag(w)) || a.includes('--list') || a.includes('-l') || has(a, ...BRANCH_FILTERS)) &&
    !a.some((w) => /^-[a-z]*[dDmMcCf]/.test(w) || ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description'].some((b) => w.startsWith(b))),
  tag: (a) => a.length === 0 || a.every((w) => w === '-l' || w === '--list'),
  remote: (a) => a.length === 0 || a.every((w) => w === '-v' || w === '--verbose'),
  worktree: (a) => a[0] === 'list',
  stash: (a) => a[0] === 'list',
  config: (a) => ['--get', '--get-all', '--list', '-l'].includes(a[0] ?? '') && a.length <= 2,
};

/** PowerShell's reading cmdlets (and their aliases). */
const POWERSHELL = new Set(['get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'test-path', 'resolve-path', 'get-item', 'gi', 'measure-object', 'select-object', 'select', 'sort-object', 'format-table', 'ft', 'format-list', 'fl', 'out-string']);

/**
 * `git checkout` options that switch to a revision or restore paths and nothing else: no new
 * branch (`-b`), no `--force` throwing work away, no patch prompt, no paths read from a file.
 */
const CHECKOUT_FLAGS = new Set(['-q', '--quiet', '--', '--ours', '--theirs', '--detach', '--progress', '--no-progress']);

/** Git subcommands that only change the worktree, its index or its branch. */
const GIT_WRITES: Record<string, (args: string[]) => boolean> = {
  add: () => true,
  // Hooks run as for a person: a commit that skips them is not judged here.
  commit: (a) => !has(a, '--no-verify', '-n'),
  restore: () => true,
  rm: () => true,
  mv: () => true,
  // A revision or paths in the worktree (every operand must stay in it), with only CHECKOUT_FLAGS.
  checkout: (a) => a.every((w) => !flag(w) || CHECKOUT_FLAGS.has(w)),
  // Finishing or dropping a rebase or merge already under way.
  rebase: (a) => a.length === 1 && ['--continue', '--abort', '--skip'].includes(a[0]!),
  // Merging a branch into this one; its operands are branch names, and hooks still run.
  merge: (a) => !has(a, '--no-verify', '-s', '--strategy', '-X', '--strategy-option'),
  stash: (a) => a.length === 0 || ['push', 'pop', 'apply', 'drop'].includes(a[0]!),
};
/** Git writes whose operands are revisions or messages, not paths. */
const GIT_NO_PATHS = new Set(['commit', 'rebase', 'merge', 'stash']);

/** `rm` with only these options deletes files, never folders, and does not prompt. */
const RM_FLAGS = /^(?:-[fv]+|--force|--verbose)$/;

/** File commands, each giving its operands, or undefined for an option this file won't judge. */
const FILE_WRITES: Record<string, (args: string[]) => string[] | undefined> = {
  mkdir: (a) => a.filter((w) => !flag(w)),
  touch: (a) => a.filter((w) => !flag(w)),
  cp: (a) => a.filter((w) => !flag(w)),
  mv: (a) => a.filter((w) => !flag(w)),
  rm: (a) => {
    const operands: string[] = [];
    let dashes = false;
    for (const w of a) {
      if (!dashes && w === '--') dashes = true;
      else if (!dashes && flag(w)) {
        if (!RM_FLAGS.test(w)) return undefined;
      } else operands.push(w);
    }
    return operands;
  },
};
/** File commands that may only touch the worktree itself, not the scratch folders. */
const WORKTREE_ONLY = new Set(['rm']);

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
 * `worktree` (its relative paths read from `where.cwd`). `cd` into the worktree or a folder in it
 * counts, since it changes nothing.
 */
export function isReadOnlyCommand(command: string, worktree: string, scratch: string[] = [], where: ShellPlace = {}): boolean {
  return readOnly(command, placeOf(worktree, scratch, where));
}

function readOnly(command: string, p: Place): boolean {
  if (!standsInside(p)) return false;
  // `echo` only prints, variables (`$?`, `$x`) included: only a redirect or a substitution does more.
  if (/^echo(\s|$)/.test(command) && !/[<>`]|\$\(/.test(command)) return true;
  const all = words(command);
  if (!all?.length) return false;
  const [program, ...args] = all;
  const name = program!.toLowerCase();
  // Writing options that every program shares.
  if (args.some((a) => a.startsWith('--output'))) return false;
  const operands = (list: string[]) => list.filter((w) => !flag(w));
  const ok = (w: string) => readable(p, w);
  const pathsInside = (list: string[]) => operands(list).every(ok);

  // `cd` changes where later commands run, so only the worktree counts there. A bare `cd` goes to
  // the home folder, and the commands after it would read there.
  if (name === 'cd') return args.length === 1 && !flag(args[0]!) && args[0] !== '-' && inside(p, args[0]!);
  if (name === 'git') {
    let rest = args;
    let at = p;
    // `git -C <folder>` in the worktree and `--no-pager`; any other option before the subcommand
    // (`-c`, `--exec-path`) is not judged.
    while (rest[0] === '--no-pager' || (rest[0] === '-C' && rest[1] !== undefined)) {
      if (rest[0] === '--no-pager') {
        rest = rest.slice(1);
        continue;
      }
      if (!inside(at, rest[1]!)) return false;
      const folder = rest[1]!;
      at = { ...at, cwds: at.cwds.map((c) => from(c, folder)) };
      rest = rest.slice(2);
    }
    // `--no-index` compares files anywhere on disk.
    if (rest.includes('--no-index')) return false;
    const [sub, ...subArgs] = rest;
    if (!sub || flag(sub)) return false;
    const check = GIT[sub];
    // A revision such as `main:.scratch/x.md` is not a path; paths after `--` are.
    const dashes = subArgs.indexOf('--');
    return !!check && check(subArgs) && (dashes < 0 || operands(subArgs.slice(dashes + 1)).every((w) => readable(at, w)));
  }
  if (POWERSHELL.has(name)) return pathsInside(args.filter((a) => !/^-[a-z]+$/i.test(a)));
  const check = PLAIN[name];
  if (!check || !check(args)) return false;
  if (name === 'echo' || NO_PATHS.has(name)) return true;
  if (name === 'sed') return !bareBackslash(command) && sedParts(args)!.every(ok);
  // grep takes a pattern first; only what follows names files.
  let files = ['grep', 'egrep', 'fgrep', 'rg'].includes(name) ? operands(args).slice(1) : operands(args);
  if (name === 'find') return files.slice(0, 1).every(ok);
  if (name === 'jq') files = files.slice(1);
  // `[ -s file ]`: the brackets and `!` are not paths, nor are the words after `=`, `-eq`, ...
  if (name === 'test' || name === '[') files = files.filter((w) => w !== ']' && w !== '!' && w !== '=' && w !== '!=');
  return files.every(ok);
}

/** Environment settings that change nothing a command could do to the computer. */
const SAFE_ENV = /^(?:GIT_EDITOR=(?:true|:)|GIT_PAGER=cat|PAGER=cat|CI=(?:1|true)|NO_COLOR=1|FORCE_COLOR=0)\s+/;
/** Shell words that only shape a loop or a branch: nothing to judge on their own. */
const SHAPE = new Set(['', 'do', 'done', 'then', 'else', 'fi', '{', '}', 'esac']);

const count = (text: string, c: string) => text.split(c).length - 1;

/**
 * One command with what only wraps it taken off: a subshell's or group's brackets left at its ends
 * by the split, `timeout N`, `time`, a background `&`, a loop's or branch's keyword (`do`, `until`,
 * `if`), PowerShell's `if ($?) { ... }`, and the harmless environment settings in SAFE_ENV. A
 * closing bracket that closes something in the command (`f=$(ls)`) stays.
 */
export function unwrap(command: string): string {
  let c = command.trim();
  for (let prev = ''; prev !== c; ) {
    prev = c;
    c = c
      .replace(/^if\s*\(\s*\$\?\s*\)\s*\{\s*/i, '')
      .replace(/^[({]\s*/, '')
      .replace(/\s+&$/, '')
      .replace(/^(?:do|then|else|elif|until|while|if|!)\s+/, '')
      .replace(/^time\s+/, '')
      .replace(/^timeout\s+(?:(?:-[sk]|--signal|--kill-after)[\s=]\S+\s+|--\w[\w-]*\s+)*\d+(?:\.\d+)?[smhd]?\s+/, '')
      .replace(SAFE_ENV, '')
      .trim();
    const close = /\s*([)}])$/.exec(c);
    if (close && count(c, close[1]!) > count(c, close[1] === ')' ? '(' : '{')) c = c.slice(0, close.index).trim();
  }
  return c;
}

/**
 * Takes out the output redirects of a command (`> file`, `>> file`, `2> file`, `&> file`) whose
 * target this file can judge, and a quoted heredoc's opener (its body is already gone). `wrote`
 * says whether a redirect wrote a file; `ok` is false when a target is outside the worktree and the
 * scratch folders, and the command is left for the Policy.
 */
function withoutRedirects(command: string, p: Place): { command: string; wrote: boolean; ok: boolean } {
  let wrote = false;
  let ok = true;
  const out = command
    .replace(/\s*<<-?\s*(['"])\w+\1/g, '')
    .replace(/(^|\s)(?:[12]|&)?>>?\s*("[^"$`]+"|'[^']+'|[^\s'"$`<>|&;()]+)/g, (whole, lead: string, target: string) => {
      const path = target.replace(/^["']|["']$/g, '');
      if (path === '/dev/null' || /^&[12]$/.test(path)) return lead;
      if (!reaches(p, path) || touchesGit(path)) {
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
function reduce(command: string, p: Place): { command: string; wrote: boolean } {
  let c = unwrap(command);
  let wrote = false;
  for (let prev = ''; prev !== c; ) {
    prev = c;
    const r = withoutRedirects(c, p);
    if (!r.ok) return { command: c, wrote: false };
    wrote ||= r.wrote;
    c = unwrap(r.command);
  }
  return { command: c, wrote };
}

/**
 * A shell variable a sole `name=value` command sets: lower case (or one capital, `F=`), so it is
 * never an environment setting a program reads (`PATH`, `GIT_DIR`), and none that zsh ties to one.
 */
const ASSIGNMENT = /^([a-z_][a-z0-9_]*|[A-Z])=([\s\S]*)$/;
const SHELL_TIED = new Set(['path', 'cdpath', 'fpath', 'manpath', 'module_path', 'mailpath', 'psvar']);

function assignment(command: string): { name: string; value: string } | undefined {
  const m = ASSIGNMENT.exec(command);
  return m && !SHELL_TIED.has(m[1]!) ? { name: m[1]!, value: m[2]! } : undefined;
}

/** The commands of a word that is one whole `$(...)` substitution, bare or in double quotes. */
function substitution(word: string): string | undefined {
  const m = /^\$\(([\s\S]*)\)$/.exec(word) ?? /^"\$\(([\s\S]*)\)"$/.exec(word);
  return m?.[1];
}

/** Whether every command of a substitution only reads. */
function readsOnly(inner: string, p: Place): boolean {
  const commands = splitCommands(inner);
  return commands.length > 0 && commands.every((c) => effectOf(c, p) === 'read');
}

/** Whether a value is one plain word (or none): something a variable can be bound to. */
const plainValue = (value: string) => {
  const list = words(value);
  return list && list.length <= 1 ? (list[0] ?? '') : undefined;
};

/**
 * What one shell command (already split from its line) does to `worktree`: `read` (it only reads
 * inside it; `cd` into it counts), `write` (it only changes files in it, its index or its branch),
 * or undefined when this file can't tell, so the Policy treats it as a command. Relative paths
 * read from `where.cwd`.
 */
export function worktreeEffect(command: string, worktree: string, scratch: string[] = [], where: ShellPlace = {}): 'read' | 'write' | undefined {
  return effectOf(command, placeOf(worktree, scratch, where));
}

function effectOf(command: string, p: Place): 'read' | 'write' | undefined {
  const { command: bare, wrote } = reduce(command, p);
  // A loop's or branch's own keywords (`done`, `fi`) do nothing.
  if (SHAPE.has(bare)) return 'read';
  if (!standsInside(p)) return undefined;
  // A `for` header over plain words, or over a substitution that only reads (`$(seq 1 55)`).
  const loop = /^for\s+\w+\s+in\s+([\s\S]*)$/.exec(bare);
  if (loop) {
    const inner = substitution(loop[1]!.trim());
    return words(loop[1]!) !== undefined || (inner !== undefined && readsOnly(inner, p)) ? 'read' : undefined;
  }
  // Setting a shell variable changes nothing on disk; a substitution in it must only read.
  const set = assignment(bare);
  if (set) {
    const inner = substitution(set.value);
    return plainValue(set.value) !== undefined || (inner !== undefined && readsOnly(inner, p)) ? 'read' : undefined;
  }
  const effect = bareEffect(bare, p);
  return effect && wrote ? 'write' : effect;
}

function bareEffect(command: string, p: Place): 'read' | 'write' | undefined {
  if (readOnly(command, p)) return 'read';
  const all = words(command);
  if (!all?.length) return undefined;
  const [program, ...args] = all;
  if (program === 'git') {
    const [sub, ...subArgs] = args;
    const check = sub ? GIT_WRITES[sub] : undefined;
    if (!check || !check(subArgs)) return undefined;
    // A commit's message, or a branch to merge, is not a path; every other operand is.
    if (GIT_NO_PATHS.has(sub!)) return 'write';
    return subArgs.filter((w) => !flag(w)).every((w) => inside(p, w) && !touchesGit(w)) ? 'write' : undefined;
  }
  // `sed -i` with a plain script edits the files it names, and nothing else.
  if (program === 'sed' && sedInPlace(args) && !bareBackslash(command)) {
    const files = sedParts(args);
    return files?.length && files.every((w) => reaches(p, w) && !touchesGit(w)) ? 'write' : undefined;
  }
  const operands = FILE_WRITES[program!]?.(args);
  const ok = (w: string) => (WORKTREE_ONLY.has(program!) ? inside(p, w) : reaches(p, w)) && !touchesGit(w);
  return operands?.length && operands.every(ok) ? 'write' : undefined;
}

/**
 * The shell variables a line sets, and their values: a `for <name> in <words>` header's words, or
 * a sole `name=value`'s plain value. A variable set from anything else (`$(...)`) is null: unknown.
 * A command using a known variable is judged once for each value, so `cat "$f"` reads the files it
 * lists; one using an unknown variable is not judged.
 */
function variables(commands: string[]): Map<string, string[] | null> {
  const vars = new Map<string, string[] | null>();
  const bind = (name: string, values: string[] | null) => {
    const had = vars.get(name);
    vars.set(name, values === null || had === null ? null : [...(had ?? []), ...values]);
  };
  for (const c of commands) {
    const bare = unwrap(c);
    const loop = /^for\s+(\w+)\s+in\s+([\s\S]*)$/.exec(bare);
    if (loop) {
      const values = words(loop[2]!);
      bind(loop[1]!, values?.length ? values : null);
      continue;
    }
    const set = assignment(bare);
    if (set) {
      const value = plainValue(set.value);
      bind(set.name, value === undefined ? null : [value]);
    }
  }
  return vars;
}

/** The command once for each value of each known variable it uses (`$f`, `"$f"`, `${f}`). */
function expand(command: string, vars: Map<string, string[] | null>): string[] {
  let out = [command];
  for (const [name, values] of vars) {
    if (values === null) continue;
    const use = new RegExp(`"?\\$(?:\\{${name}\\}|${name}\\b)"?`, 'g');
    if (!use.test(command)) continue;
    out = out.flatMap((c) => values.map((v) => c.replace(use, `'${v.replace(/'/g, '')}'`)));
  }
  return out;
}

/** Commands that change the shell's folder. */
const CHANGES_FOLDER = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location']);

/**
 * Where a command leaves the shell, from each of `cwds`, when it changes folder: `cd <path>`'s
 * target, or UNKNOWN_FOLDER for a change this file can't follow. Undefined when it stays put.
 */
function folderAfter(command: string, cwds: string[]): string[] | undefined {
  const bare = unwrap(command);
  const program = /^\S+/.exec(bare)?.[0].toLowerCase();
  if (!program || !CHANGES_FOLDER.has(program)) return undefined;
  const all = words(bare);
  // `cd -` goes back to the folder before, which this file does not track.
  const target = program === 'cd' && all?.length === 2 && !flag(all[1]!) && all[1] !== '-' ? all[1]! : undefined;
  return target === undefined ? [UNKNOWN_FOLDER] : cwds.map((c) => from(c, target));
}

const EXTERNAL_WRITES = [/^git\s+push\b/, /^gh\s+(pr|issue)\s+(create|comment|edit|close|merge|review)\b/, /^gh\s+release\s+create\b/, /^gh\s+api\b.*-X\s*(POST|PUT|PATCH|DELETE)/i];

const isKnown = (command: string, known: string[]) =>
  known.some((k) => (k.endsWith('*') ? command.startsWith(k.slice(0, -1)) : command === k));

/**
 * One shell command's action. A worktree read or write counts as one, unless a rule names it as a
 * command (an Org rule that denies `cat secrets*` still holds).
 */
function commandRequest(policy: EffectivePolicy, p: Place, command: string, judged = command): ShellRequest {
  // Rules match the command without its wrapping (`timeout 120 npm test` is `npm test`).
  const bare = reduce(judged, p).command;
  const ruled = [judged, bare].map((c) => decide(policy, 'other_commands', c)).filter((d) => d !== policy.actions.other_commands);
  if (ruled.length) return { action: 'other_commands', detail: command, decision: strictestOf(...ruled) };
  const effect = effectOf(judged, p);
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

/**
 * What a shell command line (Bash or PowerShell) run in `worktree` amounts to, and the Policy's
 * word on it. `where.cwd` is the folder the shell stands in, when that is not the worktree itself.
 */
export function shellRequest(policy: EffectivePolicy, worktree: string, line: string, scratch: string[] = [], where: ShellPlace = {}): ShellRequest {
  // Kiln never commits a Co-Authored-By trailer. The core refuses one in a Permission Ask; this
  // catches the commands the Policy allows without asking. (A `grep` for trailers is fine: only
  // lines that commit, merge or write to GitHub are refused.)
  if (/co-authored-by/i.test(line) && /\bgit\s+(commit|merge|tag|notes|rebase|cherry-pick|commit-tree)\b|\bgh\s+(pr|issue|release)\b/.test(line)) {
    return { action: 'other_commands', detail: `${line}\n(Kiln never commits a Co-Authored-By trailer: run it again without one, and add no attribution lines)`, decision: 'deny' };
  }
  // A quoted heredoc's body is data; the command that opens it is judged.
  const stripped = withoutQuotedHeredocs(line);
  const parts = splitParts(stripped);
  if (!parts.length) return { action: 'other_commands', detail: '', decision: decide(policy, 'other_commands', '') };
  const vars = variables(parts.map((part) => part.text));
  // A `cd` moves the commands after it only when they can't run without it: no `||`, no subshell
  // or group, and nothing after it but `&&` and pipes. Otherwise either folder is possible.
  const grouped = /[(){}]/.test(stripped.replace(/\$\([^()]*\)/g, ''));
  const anyOr = parts.some((part) => part.sep === '||');
  const base = placeOf(worktree, scratch, where);
  let cwds = base.cwds;
  const requests: ShellRequest[] = [];
  parts.forEach((part, k) => {
    const p = { ...base, cwds };
    // The strictest of its commands decides, and is the one a Permission Ask names.
    for (const judged of expand(part.text, vars)) requests.push(commandRequest(policy, p, part.text, judged));
    const next = folderAfter(part.text, cwds);
    if (!next) return;
    const piped = part.sep === '|' || (k > 0 && parts[k - 1]!.sep === '|');
    const sure = !grouped && !anyOr && !piped && parts.slice(k).every((q) => q.sep === '&&' || q.sep === '|' || q.sep === '');
    cwds = sure ? next : [...new Set([...cwds, ...next])];
  });
  const strictest = requests.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  // A person asked about `python - <<'EOF'` sees the script too.
  return strictest.decision === 'ask' && stripped !== line && /<<-?\s*['"]/.test(strictest.detail) ? { ...strictest, detail: line } : strictest;
}
