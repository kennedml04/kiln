// + Project → Import with the scan (project-wizard ticket 09): the Shell shows what the folder holds,
// and the person's choices become the settings commit and the Onboard Story. Temp folders only;
// the module is test-made, under the folder's `.kiln/modules`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Kiln Test', '-c', 'user.email=test@kiln.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A repo on main with a test script, a .scad file, a CAD module, and AGENTS.md as its only doc. */
function sampleRepo(t: Cleanup) {
  const dir = tempDir(t, 'kiln-import');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'AGENTS.md': '# Agents\n',
    'parts/bracket.scad': 'cube(10);\n',
    '.kiln/modules/cad/kiln-module.json': JSON.stringify({ id: 'cad', name: 'CAD part', description: 'Printable parts', detect: ['*.scad'] }),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'First');
  return dir;
}

test('Import shows the scan, and the confirmed test command, ticked module and Bring it up to date are written', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleRepo(t);
  const page = await openShell(t, kiln, '/', { viewport: { width: 390, height: 844 } });

  await page.getByRole('button', { name: '+ Project' }).click();
  const form = page.getByRole('form', { name: 'Import a Project' });
  await form.getByLabel('Repository path').fill(dir);
  const found = form.getByRole('region', { name: 'What Import found' });
  await found.getByText('A git repo on main, its default branch.').waitFor();
  await found.getByText('GLOSSARY.md: missing').waitFor();
  await found.getByText('AGENTS.md / CLAUDE.md: found').waitFor();

  await found.getByRole('radio', { name: /npm test/ }).check();
  await found.getByRole('checkbox', { name: /CAD part \(suggested: parts\/bracket\.scad\)/ }).check();
  await found.getByRole('checkbox', { name: /Bring it up to date/ }).check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await form.getByRole('button', { name: 'Register Project' }).click();
  // The dialog closes once Import has written everything (the board shows the Project before that).
  await form.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: /kiln-import/ }).first().waitFor();

  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.kiln', 'settings.json'), 'utf8')), { modules: ['cad'], testCommand: 'npm test' });
  const [project] = await kiln.api<Project[]>('GET', '/api/projects');
  const items = await kiln.api<Item[]>('GET', `/api/items?project=${project!.id}`);
  assert.deepEqual(items.map((i) => [i.title, i.stage]), [['Onboard', 'grill']]);
  assert.match(items[0]!.description!, /`GLOSSARY\.md`/);
  assert.doesNotMatch(items[0]!.description!, /`AGENTS\.md`/);
});

test('Import with nothing ticked after the scan writes only what registering writes', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = sampleRepo(t);
  const page = await openShell(t, kiln);

  await page.getByRole('button', { name: '+ Project' }).click();
  const form = page.getByRole('form', { name: 'Import a Project' });
  await form.getByLabel('Repository path').fill(dir);
  await form.getByRole('region', { name: 'What Import found' }).getByRole('radio', { name: 'None for now' }).waitFor();
  await form.getByRole('button', { name: 'Register Project' }).click();
  await form.waitFor({ state: 'detached' });

  assert.ok(!existsSync(join(dir, '.kiln', 'settings.json')));
  assert.deepEqual(git(dir, 'log', '--format=%s').trim().split('\n'), ['Kiln: add the Project Policy', 'First']);
});
