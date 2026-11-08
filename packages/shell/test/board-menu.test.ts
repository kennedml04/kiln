import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { Project } from '@kiln/widget-sdk';
import { startTestKiln, type TempRepo } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

/** The seed plus a shipped Story: Shipped recently lists Stories, not their Tickets. */
function seedShipped(repo: TempRepo) {
  seedScratch(repo);
  writeRepoFile(repo, '.scratch/old-story/story.md', ['---', 'title: Old story', 'epic: board-as-home', 'stage: shipped', 'blocked-by: []', '---', '', 'Already out.', ''].join(String.fromCharCode(10)));
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'Seed shipped Story');
}

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const sizes = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

for (const [name, viewport] of Object.entries(sizes)) {
  test(`Home: Reset board empties Shipped, shows the toast, Undo puts the cards back (${name})`, async (t) => {
    const kiln = await startTestKiln(t);
    seedShipped(kiln.repo);
    const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
    const page = await openShell(t, kiln, '/', { viewport });
    const shipped = column(page, 'Shipped recently').getByRole('article');
    await shipped.first().waitFor();
    // Reset archives every shipped Item, Tickets too, though the board lists only Stories.
    const n = (await kiln.api<{ runState: string }[]>('GET', `/api/projects/${project.id}/items`)).filter((i) => i.runState === 'shipped').length;

    const menu = page.getByRole('button', { name: 'Board menu' });
    const box = await menu.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44);
    await menu.click();
    assert.equal(await page.getByRole('menuitem', { name: 'Shipped history' }).count(), 1);
    await page.getByRole('menuitem', { name: /Reset board/ }).click();

    const toast = page.getByRole('status').filter({ hasText: `Archived ${n} shipped` });
    await toast.waitFor();
    assert.equal(await shipped.count(), 0);
    if (name === 'phone') {
      const t = await toast.locator('.toast').boundingBox();
      assert.ok(t && t.width > 350);
    }

    // Navigating doesn't hide it.
    await page.goto(`${kiln.url}/`).catch(() => undefined);
    await toast.waitFor({ state: 'detached', timeout: 1000 }).catch(() => undefined);

    // Nothing left in Shipped: disabled.
    await menu.click();
    assert.equal(await page.getByRole('menuitem', { name: /Reset board/ }).isDisabled(), true);
    await page.keyboard.press('Escape');
  });

  test(`Home: Undo brings the cards back (${name})`, async (t) => {
    const kiln = await startTestKiln(t);
    seedShipped(kiln.repo);
    const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
    const page = await openShell(t, kiln, '/', { viewport });
    const shipped = column(page, 'Shipped recently').getByRole('article');
    await shipped.first().waitFor();
    // Reset archives every shipped Item, Tickets too, though the board lists only Stories.
    const n = (await kiln.api<{ runState: string }[]>('GET', `/api/projects/${project.id}/items`)).filter((i) => i.runState === 'shipped').length;
    await page.getByRole('button', { name: 'Board menu' }).click();
    await page.getByRole('menuitem', { name: /Reset board/ }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText(`Put back ${n} Item`).waitFor();
    await shipped.first().waitFor();
    assert.equal(await shipped.count(), 1);
  });

  test(`Project board: the menu sits beside the name and Reset hides its shipped cards (${name})`, async (t) => {
    const kiln = await startTestKiln(t);
    seedShipped(kiln.repo);
    const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
    const page = await openShell(t, kiln, `/projects/${project.id}`, { viewport });
    const shipped = column(page, 'Ticket Shipped').getByRole('article');
    await shipped.first().waitFor();
    await page.getByRole('button', { name: 'Board menu' }).click();
    await page.getByRole('menuitem', { name: /Reset board/ }).click();
    await page.getByRole('status').getByText(/^Archived \d+ shipped/).waitFor();
    assert.equal(await shipped.count(), 0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await shipped.first().waitFor();
  });
}

test('a Viewer has no Reset board entry', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  seedShipped(kiln.repo);
  await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, '/', { as: 'vic' });
  await column(page, 'Shipped recently').getByRole('article').first().waitFor();
  await page.getByRole('button', { name: 'Board menu' }).click();
  await page.getByRole('menuitem', { name: 'Shipped history' }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: /Reset board/ }).count(), 0);
});
