import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchiveResetResponse, Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { writeRepoFile } from '@kiln/testing/scratch';

const epicFile = (title: string, stage: string) => `---\ntitle: ${title}\nstage: ${stage}\n---\nAbout ${title}.\n`;

async function setUp(kiln: TestKiln) {
  writeRepoFile(kiln.repo, '.scratch/epics/alpha.md', epicFile('Alpha shipped', 'shipped'));
  writeRepoFile(kiln.repo, '.scratch/epics/beta.md', epicFile('Beta shipped', 'shipped'));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Items');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const reset = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', { projectId: project.id });
  return { project, reset };
}

test('Shipped history lists a Reset, searches, and unarchives one Item then the batch', async (t) => {
  const kiln = await startTestKiln(t);
  const { project } = await setUp(kiln);
  const page = await openShell(t, kiln, '/shipped');

  await page.getByRole('heading', { name: /2 Items \(2 still archived\)/ }).waitFor();
  await page.getByRole('link', { name: 'Alpha shipped' }).waitFor();
  await page.getByRole('link', { name: 'Beta shipped' }).waitFor();

  await page.getByLabel('Search Shipped history').fill('alpha');
  await page.getByRole('link', { name: 'Beta shipped' }).waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'Alpha shipped' }).waitFor();
  await page.getByLabel('Search Shipped history').fill('');
  await page.getByRole('link', { name: 'Beta shipped' }).waitFor();

  await page.getByRole('listitem').filter({ hasText: 'Alpha shipped' }).getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('heading', { name: /\(1 still archived\)/ }).waitFor();
  const archived = async () => (await kiln.api<Item[]>('GET', '/api/items')).filter((i) => i.archived).length;
  assert.equal(await archived(), 1);

  await page.getByRole('button', { name: 'Unarchive batch' }).click();
  await page.getByRole('heading', { name: /\(0 still archived\)/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Unarchive batch' }).count(), 0);
  assert.equal(await archived(), 0);

  await page.goto(new URL(`/projects/${project.id}/shipped`, page.url()).href);
  await page.getByRole('heading', { name: /^Shipped history: / }).waitFor();
  await page.getByRole('heading', { name: /0 still archived/ }).waitFor();
});

test('an archived Item page shows the badge and Unarchive removes it', async (t) => {
  const kiln = await startTestKiln(t);
  await setUp(kiln);
  const item = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Alpha shipped')!;
  const page = await openShell(t, kiln, `/items/${encodeURIComponent(item.id)}`);
  await page.getByText(/^Archived /).waitFor();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByText(/^Archived /).waitFor({ state: 'detached' });
});
