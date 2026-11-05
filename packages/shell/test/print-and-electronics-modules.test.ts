// The 3D print and Electronics modules on the board: "Print it" and "Order parts" have no role, so
// an Item there shows as the person's move; and Settings sets the tools' paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Project, SetupState } from '@kiln/widget-sdk';
import { startTestKiln, tempDir } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { join } from 'node:path';

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const card = (page: Page, columnName: string, title: string) => column(page, columnName).getByRole('article', { name: title, exact: true });

const ticket = (n: string, title: string, stage: string) =>
  `# ${n}: ${title}\n\n**What to build:** ${title}.\n\n**Blocked by:** None\n\n**Status:** ready-for-human\n\n**Stage:** ${stage}\n\n- [ ] Done\n`;

test('"Print it" and "Order parts" show as the person\'s move on both boards; an Agent\'s Stage does not', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.scratch/home-board/issues/03-print-the-case.md', ticket('03', 'Print the case', 'print-it'));
  writeRepoFile(kiln.repo, '.scratch/home-board/issues/04-order-the-parts.md', ticket('04', 'Order the parts', 'order-parts'));
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ modules: ['3d-print', 'electronics'] }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Two Tickets waiting on a person');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(project.errors, []);
  const page = await openShell(t, kiln);

  await card(page, 'Backlog', 'Print the case').getByText('Your move').waitFor();
  await card(page, 'Backlog', 'Order the parts').getByText('Your move').waitFor();
  await card(page, 'Backlog', 'Draw the columns').getByText('Implementing').waitFor();
  assert.equal(await card(page, 'Backlog', 'Draw the columns').getByText('Your move').count(), 0);

  await page.getByRole('link', { name: project.name }).first().click();
  await card(page, 'Ticket Print it', 'Print the case').getByText('Your move').waitFor();
  await card(page, 'Ticket Order parts', 'Order the parts').getByText('Your move').waitFor();
  await card(page, 'Ticket Implementing', 'Draw the columns').waitFor();
  assert.equal(await card(page, 'Ticket Implementing', 'Draw the columns').getByText('Your move').count(), 0);
  // Shipped has no role either, but nothing is left to do there.
  assert.equal(await card(page, 'Ticket Shipped', 'Live updates').getByText('Your move').count(), 0);
});

test('Settings sets a tool path, and clears it back to PATH', async (t) => {
  const kiln = await startTestKiln(t);
  const path = join(tempDir(t, 'kiln-tools'), 'kicad-cli');
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: 'Settings' }).click();
  const form = page.getByRole('form', { name: 'Tool paths' });
  await form.waitFor({ timeout: 60_000 });

  await form.getByLabel('kicad-cli').fill(path);
  await form.getByRole('button', { name: 'Save tool paths' }).click();
  await form.getByRole('status').getByText('Saved').waitFor();
  assert.deepEqual((await kiln.api<SetupState>('GET', '/api/setup')).settings.toolPaths, { 'kicad-cli': path });

  await form.getByLabel('kicad-cli').fill('');
  await form.getByRole('button', { name: 'Save tool paths' }).click();
  await form.getByRole('status').getByText('Saved').waitFor();
  assert.deepEqual((await kiln.api<SetupState>('GET', '/api/setup')).settings.toolPaths, {});
});
