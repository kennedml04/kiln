// + Project → New in the Shell (project-wizard ticket 02). Every folder here is a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Project, SetupState } from '@kiln/widget-sdk';
import { startTestKiln, tempDir } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const openNew = async (page: Page) => {
  await page.getByRole('button', { name: '+ Project' }).click();
  return page.getByRole('form', { name: 'New Project' });
};

/** Waits for the Item view of the new Project's first Story, at Grill. */
const storyOpens = async (page: Page) => {
  await page.getByRole('heading', { name: "What we're building" }).waitFor();
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByText('Grill', { exact: true }).waitFor();
  assert.match(new URL(page.url()).pathname, /^\/items\//);
};

test('New asks for the Projects folder the first time, makes the Project and opens its Story at Grill; the next New remembers the folder', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = join(tempDir(t, 'kiln-home'), 'Projects');
  const page = await openShell(t, kiln);

  let form = await openNew(page);
  await form.getByLabel('Projects folder').fill(projects);
  await form.getByLabel('Name').fill('desk-bracket');
  await form.getByLabel('Description').fill('A bracket that holds the router under the desk.');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await storyOpens(page);
  assert.ok(existsSync(join(projects, 'desk-bracket', 'README.md')));
  assert.equal((await kiln.api<SetupState>('GET', '/api/setup')).settings.projectsFolder, projects);

  await page.goto(kiln.url);
  form = await openNew(page);
  await form.getByText(`Made in ${projects}`).waitFor();
  assert.equal(await form.getByLabel('Projects folder').count(), 0, 'the Projects folder is asked for once');
  await form.getByLabel('Name').fill('pcb-clock');
  await form.getByLabel('Description').fill('A clock on a small PCB.');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await storyOpens(page);
  const names = (await kiln.api<Project[]>('GET', '/api/projects')).map((p) => p.name).sort();
  assert.deepEqual(names, ['desk-bracket', 'pcb-clock']);
});

test('a failed step is named in the form, and Create again finishes the job', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });
  const folder = join(projects, 'desk-bracket');
  mkdirSync(folder);
  writeFileSync(join(folder, '.git'), 'gitdir: ./nowhere\n');
  const page = await openShell(t, kiln, '/', { viewport: { width: 390, height: 844 } });

  const form = await openNew(page);
  await form.getByLabel('Name').fill('desk-bracket');
  await form.getByLabel('Description').fill('A bracket that holds the router under the desk.');
  await form.getByRole('button', { name: 'Create Project' }).click();
  await form.getByRole('alert').getByText(/Step 3 of 5 \(git init and the first commit\) failed/).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    true,
    'no sideways scroll at phone width',
  );

  rmSync(join(folder, '.git'));
  await form.getByRole('button', { name: 'Create Project' }).click();
  await storyOpens(page);
  assert.equal(git(folder, 'log', '--format=%an', '--max-parents=0').trim(), 'Kiln');
});
