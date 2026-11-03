import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const card = (page: Page, columnName: string, title: string) =>
  column(page, columnName).getByRole('article', { name: title, exact: true });

test('the home board and the Project view show the same Items in the same Stages', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln);

  await card(page, 'Backlog', 'Home board').getByText('Spec').waitFor();
  await card(page, 'Backlog', 'Board as home').getByText('Roadmap').waitFor();
  await card(page, 'Backlog', 'Draw the columns').getByText('Implementing').waitFor();
  await card(page, 'Shipped recently', 'Live updates').waitFor();

  await page.getByRole('link', { name: project.name }).first().click();

  await page.getByRole('heading', { name: project.name }).waitFor();
  await card(page, 'Epic Roadmap', 'Board as home').waitFor();
  await card(page, 'Story Spec', 'Home board').waitFor();
  await card(page, 'Ticket Implementing', 'Draw the columns').waitFor();
  await card(page, 'Ticket Shipped', 'Live updates').waitFor();
  assert.equal(await column(page, 'Ticket Review').getByRole('article').count(), 0);
});

test('editing an Item file updates both boards live without a page reload', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);
  await card(page, 'Story Spec', 'Home board').waitFor();
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));

  const story = readRepoFile(kiln.repo, '.scratch/home-board/story.md');
  writeRepoFile(kiln.repo, '.scratch/home-board/story.md', story.replace('stage: spec', 'stage: tickets'));

  await card(page, 'Story Tickets', 'Home board').waitFor();
  await page.getByRole('link', { name: 'All Projects' }).click();
  await card(page, 'Backlog', 'Home board').getByText('Tickets').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded), true);
});

test('a person registers a Project and creates a Ticket from the Shell, written into the repo', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const page = await openShell(t, kiln);

  await page.getByLabel('Repository path').fill(kiln.repo.path);
  await page.getByRole('button', { name: 'Register Project' }).click();
  await card(page, 'Backlog', 'Home board').waitFor();
  await page.getByRole('link', { name: /^kiln-repo/ }).first().click();

  const form = page.getByRole('form', { name: 'New Item' });
  await form.getByLabel('Kind').selectOption({ label: 'Ticket' });
  await form.getByLabel('Parent').selectOption({ label: 'Home board' });
  await form.getByLabel('Title').fill('Drag to prioritise');
  await form.getByLabel('Description').fill('Order Up next by dragging.');
  await form.getByRole('button', { name: 'Create' }).click();

  await card(page, 'Ticket Implementing', 'Drag to prioritise').waitFor();
  assert.ok(existsSync(join(kiln.repo.path, '.scratch/home-board/issues/03-drag-to-prioritise.md')));
});

test('dragging an Item to another Stage column is refused', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  await card(page, 'Story Spec', 'Home board').dragTo(column(page, 'Story Shipped'));

  await page.getByRole('alert').filter({ hasText: /Exit.*Gate/ }).waitFor();
  await card(page, 'Story Spec', 'Home board').waitFor();
  assert.equal(await column(page, 'Story Shipped').getByRole('article').count(), 0);
});
