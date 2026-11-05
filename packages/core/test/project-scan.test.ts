// The Import scan (`POST /api/projects/scan`) and what Import writes from it: the confirmed test
// command and modules in `.kiln/settings.json`, and the Onboard Story (project-wizard ticket 09).
// Every folder here is a temp folder; the modules are test-made, under the folder's `.kiln/modules`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Item, Project, ProjectScan } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup } from '@kiln/testing';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Kiln Test', '-c', 'user.email=test@kiln.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

const module = (id: string, detect: string[]) =>
  JSON.stringify({ id, name: id.toUpperCase(), description: `The ${id} module`, detect });

/** Each script would leave a `ran-*` file behind if anything ran it. */
const SENTINEL = (name: string) => `node -e "require('fs').writeFileSync('ran-${name}', '')"`;

/** A folder with docs, test commands in all three files, and three modules of which two match. */
function sampleFolder(t: Cleanup, extra: Record<string, string> = {}) {
  const dir = tempDir(t, 'kiln-scan');
  write(dir, {
    'package.json': JSON.stringify({
      scripts: { test: SENTINEL('test'), 'test:e2e': SENTINEL('e2e'), build: SENTINEL('build'), pretest: SENTINEL('pretest') },
    }),
    'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n',
    Makefile: `.PHONY: test\ntest:\n\t${SENTINEL('make')}\n\nlint: test\n\techo lint\n`,
    'GLOSSARY.md': '# Glossary\n',
    'CLAUDE.md': '@AGENTS.md\n',
    'docs/adr/0001-first.md': '# First\n',
    'parts/bracket.scad': 'cube(10);\n',
    'node_modules/pkg/board.kicad_pro': '{}',
    '.kiln/modules/cad/kiln-module.json': module('cad', ['*.scad']),
    '.kiln/modules/writing/kiln-module.json': module('writing', ['docs/**/*.md']),
    '.kiln/modules/electronics/kiln-module.json': module('electronics', ['*.kicad_pro']),
    ...extra,
  });
  return dir;
}

const makeRepo = (dir: string) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'First');
};

const scan = (kiln: Awaited<ReturnType<typeof startTestKiln>>, path: string) => kiln.api<ProjectScan>('POST', '/api/projects/scan', { path });

const log = (dir: string) => git(dir, 'log', '--format=%s').trim().split('\n');

test('the scan is Admin-only', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const dir = sampleFolder(t);
  assert.equal((await kiln.as('mo').request('POST', '/api/projects/scan', { path: dir })).status, 403);
  assert.equal((await kiln.request('POST', '/api/projects/scan', { path: dir })).status, 200);
});

test('the scan finds docs, test commands and modules in a sample folder, and runs no commands', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleFolder(t);
  makeRepo(dir);

  const found = await scan(kiln, dir);
  assert.equal(found.path, dir);
  assert.deepEqual(
    found.docs.map((d) => [d.id, d.found, d.paths]),
    [
      ['scratch', false, []],
      ['adr', true, ['docs/adr']],
      ['glossary', true, ['GLOSSARY.md']],
      ['agents', true, ['CLAUDE.md']],
    ],
  );
  assert.deepEqual(
    found.testCommands.map((c) => [c.command, c.source]),
    [
      ['npm test', 'package.json'],
      ['npm run test:e2e', 'package.json'],
      ['pytest', 'pyproject.toml'],
      ['make test', 'Makefile'],
    ],
  );
  // node_modules is never walked, so the .kicad_pro in it does not suggest Electronics.
  assert.deepEqual(
    found.modules.map((m) => [m.id, m.suggested, m.matches]),
    [
      ['cad', true, ['parts/bracket.scad']],
      ['writing', true, ['docs/adr/0001-first.md']],
      ['electronics', false, []],
    ],
  );
  assert.deepEqual(found.git, { state: 'ready', branch: 'main', defaultBranch: 'main', message: found.git.message });
  assert.deepEqual(found.settings, {});

  const ran = ['test', 'e2e', 'build', 'pretest', 'make'].filter((name) => existsSync(join(dir, `ran-${name}`)));
  assert.deepEqual(ran, [], 'the scan ran a script');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the scan wrote nothing');
});

test('the scan reads the git state from files: not a repo, no commits, off the default branch, not the top', async (t) => {
  const kiln = await startTestKiln(t);
  const plain = sampleFolder(t);
  assert.equal((await scan(kiln, plain)).git.state, 'not-a-repo');

  const empty = sampleFolder(t);
  git(empty, 'init', '-q', '-b', 'main');
  assert.equal((await scan(kiln, empty)).git.state, 'no-commits');

  const off = sampleFolder(t);
  makeRepo(off);
  git(off, 'switch', '-q', '-c', 'my-experiment');
  const offScan = await scan(kiln, off);
  assert.equal(offScan.git.state, 'off-default-branch');
  assert.equal(offScan.git.branch, 'my-experiment');
  assert.equal(offScan.git.defaultBranch, 'main');
  assert.match(offScan.git.message, /git switch main/);

  assert.equal((await scan(kiln, join(off, 'parts'))).git.state, 'not-repo-top');
  assert.equal((await kiln.request('POST', '/api/projects/scan', { path: join(off, 'missing') })).status, 404);
  assert.equal((await kiln.request('POST', '/api/projects/scan', { path: 'relative' })).status, 400);
});

test('a Python-only and a Make-only folder give their own guesses, and existing settings are reported', async (t) => {
  const kiln = await startTestKiln(t);
  const py = tempDir(t, 'kiln-py');
  write(py, { 'pyproject.toml': '[project]\ndependencies = []\n[project.optional-dependencies]\ntest = ["pytest>=8"]\n', 'uv.lock': '' });
  assert.deepEqual((await scan(kiln, py)).testCommands.map((c) => c.command), ['uv run pytest']);

  const make = tempDir(t, 'kiln-make');
  write(make, {
    Makefile: 'check:\n\t./run-checks\ntest-unit test-all: deps\n\techo\nCC := gcc\n',
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    '.kiln/settings.json': JSON.stringify({ testCommand: 'make check', localOnly: true }),
  });
  const found = await scan(kiln, make);
  assert.deepEqual(found.testCommands.map((c) => c.command), ['make check', 'make test-unit', 'make test-all']);
  assert.deepEqual(found.settings, { testCommand: 'make check' });
  assert.deepEqual(found.docs.map((d) => d.found), [false, false, false, false]);
});

test('Import writes the confirmed test command and modules to .kiln/settings.json in one commit', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleFolder(t, { '.kiln/settings.json': JSON.stringify({ localOnly: true, modules: ['writing'] }) });
  makeRepo(dir);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir, testCommand: 'npm test', modules: ['cad', 'writing'] });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.kiln', 'settings.json'), 'utf8')), {
    localOnly: true,
    modules: ['writing', 'cad'],
    testCommand: 'npm test',
  });
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim(), '.kiln/settings.json');
  assert.equal(git(dir, 'log', '-1', '--format=%an', 'HEAD').trim(), 'Kiln');
  assert.equal(git(dir, 'log', '-1', '--format=%B', 'HEAD').trim(), 'Kiln: import settings (test command, modules)');
  assert.deepEqual(log(dir), ['Kiln: import settings (test command, modules)', 'Kiln: add the Project Policy', 'First']);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.deepEqual(await kiln.api<Item[]>('GET', `/api/items?project=${project.id}`), []);

  // The Project picks the settings up from the file.
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
    const now = await kiln.api<Project>('GET', `/api/projects/${project.id}`);
    if (now.settings.testCommand === 'npm test') {
      assert.deepEqual(now.settings.modules, ['writing', 'cad']);
      return;
    }
  }
  assert.fail('the Project never read the imported settings');
});

test('Import refuses a module the folder does not have, or a blank test command, and registers nothing', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleFolder(t);
  makeRepo(dir);
  const unknown = await kiln.request<{ error: string }>('POST', '/api/projects', { path: dir, modules: ['nope'] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /"nope" is not a module/);
  assert.equal((await kiln.request('POST', '/api/projects', { path: dir, testCommand: '  ' })).status, 400);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
  assert.deepEqual(log(dir), ['First']);
});

test('Bring it up to date creates a grill-stage Onboard Story listing exactly the docs that are missing', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = tempDir(t, 'kiln-onboard');
  write(dir, { 'README.md': '# App\n', 'AGENTS.md': '# Agents\n' });
  makeRepo(dir);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir, onboard: true });
  const items = await kiln.api<Item[]>('GET', `/api/items?project=${project.id}`);
  assert.equal(items.length, 1);
  const [story] = items;
  assert.equal(story!.kind, 'story');
  assert.equal(story!.title, 'Onboard');
  assert.equal(story!.stage, 'grill');
  const missing = story!.description!.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.split(':')[0]);
  assert.deepEqual(missing, ['- `.scratch/`', '- `docs/adr/`', '- `GLOSSARY.md`']);
  assert.ok(!existsSync(join(dir, '.kiln', 'settings.json')), 'onboarding alone writes no settings');
  assert.equal(git(dir, 'log', '-1', '--format=%B').trim(), 'Add story: Onboard');
});

test('Import with everything ticked commits the settings, then creates the Onboard Story', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleFolder(t);
  makeRepo(dir);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir, testCommand: 'make test', modules: ['cad'], onboard: true });
  assert.deepEqual(log(dir), ['Add story: Onboard', 'Kiln: import settings (test command, modules)', 'Kiln: add the Project Policy', 'First']);
  const items = await kiln.api<Item[]>('GET', `/api/items?project=${project.id}`);
  assert.deepEqual(items.map((i) => i.title), ['Onboard']);
  assert.deepEqual(items[0]!.description!.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.split(':')[0]), ['- `.scratch/`']);
});

test('an import with nothing ticked registers the Project and writes nothing else', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleFolder(t);
  makeRepo(dir);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir, modules: [], onboard: false });
  assert.equal(project.path, dir);
  assert.ok(!existsSync(join(dir, '.kiln', 'settings.json')));
  assert.ok(!existsSync(join(dir, '.scratch')));
  // Only the Project Policy template every registration writes.
  assert.deepEqual(log(dir), ['Kiln: add the Project Policy', 'First']);
  assert.deepEqual(await kiln.api<Item[]>('GET', `/api/items?project=${project.id}`), []);
});
