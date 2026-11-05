// Import (project-wizard ticket 09): the scan, and what Import writes from what the person confirmed.
//
// The scan (`POST /api/projects/scan`) only reads files. It never runs a command, neither the repo's
// scripts nor git (the git state is read from the `.git` folder), and no AI looks at the folder.
// Import then registers the Project, writes the confirmed test command and ticked modules to
// `.kiln/settings.json` in one commit, and, when asked, creates the Onboard Story through the Tracker.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import {
  PROJECT_SETTINGS_FILE,
  type ImportOptions,
  type Project,
  type ProjectScan,
  type RegisterProjectRequest,
  type ScanDoc,
  type ScanGit,
  type ScanModule,
  type TestCommandGuess,
} from '@kiln/widget-sdk';
import { git } from '../flow/git.ts';
import { loadModules, moduleSources } from './modules.ts';
import { validateSettings } from './project-files.ts';
import { WorkError, type Work } from './work.ts';

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const read = (path: string) => (isFile(path) ? readFileSync(path, 'utf8') : undefined);

// ---- Docs ----

function scanDocs(root: string): ScanDoc[] {
  const agents = ['AGENTS.md', 'CLAUDE.md'].filter((f) => isFile(join(root, f)));
  const one = (id: ScanDoc['id'], name: string, path: string, dir: boolean): ScanDoc => {
    const found = dir ? isDir(join(root, path)) : isFile(join(root, path));
    return { id, name, found, paths: found ? [path] : [] };
  };
  return [
    one('scratch', '.scratch/', '.scratch', true),
    one('adr', 'docs/adr/', 'docs/adr', true),
    one('glossary', 'GLOSSARY.md', 'GLOSSARY.md', false),
    { id: 'agents', name: 'AGENTS.md / CLAUDE.md', found: agents.length > 0, paths: agents },
  ];
}

/** What each missing doc is for, as the Onboard Story lists it. */
const ONBOARD_LINES: Record<ScanDoc['id'], string> = {
  scratch: '- `.scratch/`: the Tracker\'s folder. Set up the local markdown issue tracker, with `docs/agents/issue-tracker.md` saying how it works',
  adr: '- `docs/adr/`: the decision records. Write an ADR for each decision the code and its history already show',
  glossary: '- `GLOSSARY.md`: the domain terms this repo uses, each with a one-line meaning',
  agents: '- `AGENTS.md` (or `CLAUDE.md`): how to build and test, the layout, and the rules an Agent must follow here',
};

function onboardDescription(missing: ScanDoc[]): string {
  return [
    'Bring this Project up to date with the docs a Kiln Project keeps. Import found these missing; write each one from what the repo already holds, and nothing else.',
    ...missing.map((d) => ONBOARD_LINES[d.id]),
  ].join('\n');
}

// ---- Test commands ----

const NPM_PLACEHOLDER = /no test specified/;

function packageGuesses(root: string): TestCommandGuess[] {
  const text = read(join(root, 'package.json'));
  if (text === undefined) return [];
  let scripts: unknown;
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];
  const runner = isFile(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : isFile(join(root, 'yarn.lock')) ? 'yarn' : isFile(join(root, 'bun.lock')) || isFile(join(root, 'bun.lockb')) ? 'bun' : 'npm';
  const guesses: TestCommandGuess[] = [];
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string' || !/^test([:_-]|$)/.test(name)) continue;
    if (name === 'test' && NPM_PLACEHOLDER.test(body)) continue;
    const command = name === 'test' && runner !== 'bun' ? `${runner} test` : runner === 'yarn' ? `yarn ${name}` : `${runner} run ${name}`;
    guesses.push({ command, source: 'package.json', why: `the "${name}" script` });
  }
  // `npm test` first: it is the one a repo means by "the tests".
  return guesses.sort((a, b) => Number(b.why === 'the "test" script') - Number(a.why === 'the "test" script'));
}

function pyprojectGuesses(root: string): TestCommandGuess[] {
  const text = read(join(root, 'pyproject.toml'));
  if (text === undefined || !/pytest/.test(text)) return [];
  const runner = isFile(join(root, 'uv.lock')) ? 'uv run ' : isFile(join(root, 'poetry.lock')) ? 'poetry run ' : '';
  const why = /^\[tool\.pytest/m.test(text) ? 'its [tool.pytest] settings' : 'pytest in its dependencies';
  return [{ command: `${runner}pytest`, source: 'pyproject.toml', why }];
}

function makefileGuesses(root: string): TestCommandGuess[] {
  const text = read(join(root, 'Makefile')) ?? read(join(root, 'makefile'));
  if (text === undefined) return [];
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // A rule line: targets, then a colon that is not `:=` or `::=`.
    const rule = /^([A-Za-z0-9_][A-Za-z0-9_. -]*?)\s*:(?![:=])/.exec(line);
    if (!rule) continue;
    for (const target of rule[1]!.split(/\s+/)) {
      if (/^(test|check)([_-].+)?$/.test(target) && !targets.includes(target)) targets.push(target);
    }
  }
  return targets.map((target) => ({ command: `make ${target}`, source: 'Makefile', why: `the "${target}" target` }));
}

// ---- Modules ----

/** Folders the walk never goes into: tools' caches and installed packages, not the repo's own files. */
const SKIP_DIRS = new Set(['.git', '.kiln', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache']);
const MAX_FILES = 20_000;
const MAX_MATCHES = 3;

/** The repo's files, repo-relative with `/`, sorted; junctions and symlinks are not followed. */
function listFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) files.push(rel);
    }
  };
  walk(root, '');
  return files;
}

/** A glob with no `/` matches a file's name at any depth (like `.gitignore`); one with a `/` matches the repo-relative path. */
const globMatches = (glob: string, file: string) =>
  glob.includes('/') ? posix.matchesGlob(file, glob) : posix.matchesGlob(posix.basename(file), glob);

function scanModules(root: string): ScanModule[] {
  const { modules } = loadModules(moduleSources(root));
  if (modules.size === 0) return [];
  const files = listFiles(root);
  const found = [...modules.values()].map(({ module }): ScanModule => {
    const globs = module.detect ?? [];
    const matches = globs.length ? files.filter((f) => globs.some((g) => globMatches(g, f))).slice(0, MAX_MATCHES) : [];
    return { id: module.id, name: module.name, description: module.description, suggested: matches.length > 0, matches };
  });
  return [...found.filter((m) => m.suggested), ...found.filter((m) => !m.suggested)];
}

// ---- Git, read from files ----

/** The folder's own git dir (a `.git` folder, or the one a `.git` file points to). */
function ownGitDir(root: string): string | undefined {
  const dotGit = join(root, '.git');
  if (isDir(dotGit)) return dotGit;
  const pointer = read(dotGit);
  const target = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
  return target ? resolve(root, target) : undefined;
}

function scanGit(root: string): ScanGit {
  const gitDir = ownGitDir(root);
  if (!gitDir) {
    for (let at = root; dirname(at) !== at; ) {
      at = dirname(at);
      if (existsSync(join(at, '.git'))) {
        return { state: 'not-repo-top', message: `This folder is inside the git repo at ${at}, not at its top. Import the repo's top folder instead.` };
      }
    }
    return { state: 'not-a-repo', message: 'Not a git repo yet. Every Project is one: Initialise as a git repo makes it one, with a first commit.' };
  }
  const commonFile = join(gitDir, 'commondir');
  const commonDir = isFile(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
  const packed = read(join(commonDir, 'packed-refs')) ?? '';
  const hasRef = (ref: string) =>
    isFile(join(gitDir, ref)) || isFile(join(commonDir, ref)) || packed.split(/\r?\n/).some((line) => line.endsWith(` ${ref}`));
  const head = (read(join(gitDir, 'HEAD')) ?? '').trim();
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  if (ref && !hasRef(ref)) {
    return { state: 'no-commits', branch, message: 'A git repo with no commits yet. Make a first commit there, then import it.' };
  }
  // As `defaultBranch` in flow/git.ts: origin's HEAD, else main, else master, else the checkout's branch.
  const originHead = /^ref:\s*refs\/remotes\/origin\/(.+)$/.exec((read(join(commonDir, 'refs', 'remotes', 'origin', 'HEAD')) ?? '').trim())?.[1];
  const base = originHead ?? ['main', 'master'].find((name) => hasRef(`refs/heads/${name}`)) ?? branch ?? 'main';
  if (branch !== base) {
    return {
      state: 'off-default-branch',
      branch,
      defaultBranch: base,
      message: `On ${branch ?? 'a detached HEAD'}, not its default branch ${base}. Run \`git switch ${base}\` there first: Kiln never switches branches for you.`,
    };
  }
  return { state: 'ready', branch, defaultBranch: base, message: `A git repo on ${base}, its default branch.` };
}

// ---- Settings ----

/** The `.kiln/settings.json` object as it is, or undefined when there is none. */
function readSettingsObject(root: string): Record<string, unknown> | undefined {
  const text = read(join(root, PROJECT_SETTINGS_FILE));
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new WorkError(409, `${PROJECT_SETTINGS_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix it first, then import again.`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WorkError(409, `${PROJECT_SETTINGS_FILE} must be a JSON object. Fix it first, then import again.`);
  return raw as Record<string, unknown>;
}

// ---- The scan ----

/** What Import shows for a folder. Reads files only. */
export function scanFolder(path: unknown): ProjectScan {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new WorkError(400, 'The scan needs the absolute path of a folder');
  const root = resolve(path);
  if (!isDir(root)) throw new WorkError(404, `No folder at ${root}`);
  let settings: ProjectScan['settings'] = {};
  try {
    const raw = readSettingsObject(root);
    if (raw) {
      const { testCommand, modules } = validateSettings(raw).settings;
      settings = { ...(testCommand ? { testCommand } : {}), ...(modules ? { modules } : {}) };
    }
  } catch {
    // A broken settings file shows as a Project error once registered; the scan reports none.
  }
  return {
    path: root,
    docs: scanDocs(root),
    testCommands: [...packageGuesses(root), ...pyprojectGuesses(root), ...makefileGuesses(root)],
    modules: scanModules(root),
    git: scanGit(root),
    settings,
  };
}

// ---- Import ----

/**
 * `POST /api/projects`: registers the Project, then writes what Import confirmed. With no test
 * command, no modules and no `onboard`, it is a plain registration and writes nothing else.
 */
export async function registerProject(work: Work, request: RegisterProjectRequest & ImportOptions): Promise<Project> {
  const { testCommand, modules = [], onboard } = request ?? ({} as RegisterProjectRequest);
  if (testCommand !== undefined && (typeof testCommand !== 'string' || !testCommand.trim())) {
    throw new WorkError(400, 'The test command must be a command line');
  }
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string' && m.trim())) {
    throw new WorkError(400, 'modules must be a list of module ids');
  }
  const writesSettings = testCommand !== undefined || modules.length > 0;
  const root = typeof request?.path === 'string' && request.path ? resolve(request.path) : undefined;
  let missing: ScanDoc[] = [];
  let existing: Record<string, unknown> | undefined;
  // Everything that can refuse the import is checked before the Project is registered.
  if (root && isDir(root) && (writesSettings || onboard === true)) {
    if (modules.length) {
      const known = loadModules(moduleSources(root)).modules;
      const available = [...known.keys()].sort();
      for (const id of modules) {
        if (!known.has(id)) {
          throw new WorkError(400, `${JSON.stringify(id)} is not a module. ${available.length ? `The modules are: ${available.join(', ')}` : 'No modules are available'}`);
        }
      }
    }
    if (writesSettings) existing = readSettingsObject(root);
    if (onboard === true) missing = scanDocs(root).filter((d) => !d.found);
  }

  const project = await work.register(request);
  if (writesSettings) await commitSettings(project.path, existing, testCommand?.trim(), modules);
  if (missing.length) {
    await work.createItem(project.id, { kind: 'story', title: 'Onboard', description: onboardDescription(missing) });
  }
  return work.project(project.id) ?? project;
}

/** Writes the test command and modules into `.kiln/settings.json` (keeping its other settings) and commits that file alone, as Kiln. */
async function commitSettings(root: string, existing: Record<string, unknown> | undefined, testCommand: string | undefined, modules: string[]) {
  const relative = PROJECT_SETTINGS_FILE;
  if (existing && (await git(root, 'status', '--porcelain', '--', relative)).trim()) {
    throw new WorkError(409, `The Project is registered, but ${relative} has uncommitted changes, so Import left it alone. Commit them, then set the test command and modules there.`);
  }
  const next: Record<string, unknown> = { ...(existing ?? {}) };
  if (modules.length) {
    const before = Array.isArray(next.modules) ? (next.modules as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    next.modules = [...before, ...modules.filter((m) => !before.includes(m))];
  }
  if (testCommand) next.testCommand = testCommand;
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const what = [testCommand ? 'test command' : '', modules.length ? 'modules' : ''].filter(Boolean).join(', ');
  await git(root, 'add', '--', relative);
  await git(root, 'commit', '-q', '-m', `Kiln: import settings (${what})`, '--', relative);
}
