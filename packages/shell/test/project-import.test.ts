// + Project → Import and the folder browser in the Shell (project-wizard ticket 01).
// Every folder here is a temp folder; the browse roots point only at them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Project, SetupState } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Kiln Test', '-c', 'user.email=test@kiln.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A browse root holding `app` (a git repo on main) and `notes` (a plain folder). */
function browseRoot(t: Cleanup) {
  const root = tempDir(t, 'kiln-browse');
  const app = join(root, 'app');
  mkdirSync(app);
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, 'README.md'), '# App\n');
  git(app, 'add', '.');
  git(app, 'commit', '-q', '-m', 'First');
  const notes = join(root, 'notes');
  mkdirSync(notes);
  writeFileSync(join(notes, 'plan.md'), '# Plan\n');
  return { root, app, notes };
}

const openImport = async (page: Page) => {
  await page.getByRole('button', { name: '+ Project' }).click();
  return page.getByRole('form', { name: 'Import a Project' });
};

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('+ Project → Import registers a Project picked from the folder tree', async (t) => {
  const kiln = await startTestKiln(t);
  const { root, app } = browseRoot(t);
  await kiln.api('PUT', '/api/setup', { browseRoots: [root] });
  const page = await openShell(t, kiln);

  const form = await openImport(page);
  const tree = form.getByRole('tree', { name: 'Folders' });
  await tree.getByRole('button', { name: root }).click();
  await tree.getByRole('button', { name: /^app/ }).getByText('git repo').waitFor();
  await tree.getByRole('button', { name: /^app/ }).click();
  assert.equal(await form.getByLabel('Repository path').inputValue(), app);
  await form.getByRole('button', { name: 'Register Project' }).click();

  await page.getByRole('link', { name: 'app' }).first().waitFor();
  const projects = await kiln.api<Project[]>('GET', '/api/projects');
  assert.deepEqual(
    projects.map((p) => p.path.toLowerCase()),
    [app.toLowerCase()],
  );
});

test('a typed path registers too, and a folder that is not a git repo is offered Initialise', async (t) => {
  const kiln = await startTestKiln(t);
  const { app, notes } = browseRoot(t);
  const page = await openShell(t, kiln);

  let form = await openImport(page);
  await form.getByText(/No folders to browse yet/).waitFor();
  await form.getByLabel('Repository path').fill(app);
  await form.getByRole('button', { name: 'Register Project' }).click();
  await page.getByRole('link', { name: 'app' }).first().waitFor();

  form = await openImport(page);
  await form.getByLabel('Repository path').fill(notes);
  await form.getByRole('button', { name: 'Register Project' }).click();
  await form.getByRole('alert').getByText(/not a git repo/i).waitFor();
  await form.getByRole('button', { name: 'Initialise as a git repo' }).click();
  await page.getByRole('link', { name: 'notes' }).first().waitFor();
  assert.match(git(notes, 'log', '--format=%an %s', '--max-parents=0'), /^Kiln Initial commit/);
});

test('a repo off its default branch is refused with the fix, and no Initialise is offered', async (t) => {
  const kiln = await startTestKiln(t);
  const { app } = browseRoot(t);
  git(app, 'switch', '-q', '-c', 'my-experiment');
  const page = await openShell(t, kiln);

  const form = await openImport(page);
  await form.getByLabel('Repository path').fill(app);
  await form.getByRole('button', { name: 'Register Project' }).click();
  await form.getByRole('alert').getByText(/git switch main/).waitFor();
  assert.equal(await form.getByRole('button', { name: 'Initialise as a git repo' }).count(), 0);
  assert.equal(git(app, 'branch', '--show-current').trim(), 'my-experiment');
});

test('Import works at phone width', async (t) => {
  const kiln = await startTestKiln(t);
  const { root, app } = browseRoot(t);
  await kiln.api('PUT', '/api/setup', { browseRoots: [root] });
  const page = await openShell(t, kiln, '/', { viewport: { width: 390, height: 844 } });

  const form = await openImport(page);
  const tree = form.getByRole('tree', { name: 'Folders' });
  await tree.getByRole('button', { name: root }).click();
  await tree.getByRole('button', { name: /^app/ }).click();
  assert.equal(await noSidewaysScroll(page), true);
  await form.getByRole('button', { name: 'Register Project' }).click();
  await page.getByRole('link', { name: 'app' }).first().waitFor();
  assert.equal(await noSidewaysScroll(page), true);
  assert.equal((await kiln.api<Project[]>('GET', '/api/projects'))[0]?.path.toLowerCase(), app.toLowerCase());
});

test('the Knowledge store folder in Settings uses the folder browser, and Settings saves the browse roots', async (t) => {
  const kiln = await startTestKiln(t);
  const { root, notes } = browseRoot(t);
  // Reached by clicking, as a person would: loading /settings directly timed out under a full parallel run.
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: 'Settings' }).click();
  const form = page.getByRole('form', { name: 'Folders' });
  await form.waitFor({ timeout: 60_000 });

  await form.getByLabel('Add a browse root').fill(root);
  await form.getByRole('button', { name: 'Add root' }).click();
  await form.getByRole('button', { name: 'Save folders' }).click();
  await form.getByRole('status').getByText('Saved').waitFor();

  const tree = form.getByRole('tree', { name: 'Knowledge store folders' });
  await tree.getByRole('button', { name: root }).click();
  await tree.getByRole('button', { name: /^notes/ }).click();
  assert.equal(await form.getByLabel('Knowledge store folder', { exact: true }).inputValue(), notes);
  await form.getByRole('button', { name: 'Save folders' }).click();
  await form.getByRole('status').getByText('Saved').waitFor();

  const setup = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(setup.settings.browseRoots, [root]);
  assert.equal(setup.settings.knowledgeDir, notes);
});

test('the setup wizard picks the Knowledge store folder with the same browser', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  await wizard.getByRole('heading', { name: 'Login', level: 3 }).waitFor();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('heading', { name: 'Knowledge store', level: 3 }).waitFor();

  // A dev instance browses its own data folder.
  const tree = wizard.getByRole('tree', { name: 'Knowledge store folders' });
  await tree.getByRole('button', { name: kiln.dataDir }).click();
  assert.equal(await wizard.getByLabel('Knowledge store folder', { exact: true }).inputValue(), kiln.dataDir);
});
