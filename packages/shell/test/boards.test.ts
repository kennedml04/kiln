import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { DemoState, Project } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
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

test('in a Project with no Stories, the New Item form says a Ticket needs one first, then offers it as the only parent', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);
  const form = page.getByRole('form', { name: 'New Item' });

  await form.getByLabel('Kind').selectOption({ label: 'Ticket' });
  await form.getByRole('note').filter({ hasText: 'A Ticket needs a Story as its parent. Create a Story first.' }).waitFor();
  assert.equal(await form.getByLabel('Parent').count(), 0);
  assert.equal(await form.getByRole('button', { name: 'Create' }).isDisabled(), true);

  await form.getByLabel('Kind').selectOption({ label: 'Story' });
  await form.getByLabel('Title').fill('End-to-end test');
  await form.getByRole('button', { name: 'Create' }).click();
  await card(page, 'Story Grill', 'End-to-end test').waitFor();

  await form.getByLabel('Kind').selectOption({ label: 'Ticket' });
  const parent = form.getByLabel('Parent');
  assert.deepEqual(await parent.locator('option').allTextContents(), ['End-to-end test']);
  await form.getByLabel('Title').fill('Add a line to the README');
  await form.getByRole('button', { name: 'Create' }).click();
  await card(page, 'Ticket Implementing', 'Add a line to the README').waitFor();
});

const DEMO_STORY = 'Add `slugify(title)`';
const ROLES = ['griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer'];

/** Records every browser dialog: the demo's confirmation is in the page, so there must be none. */
const noBrowserDialogs = (page: Page) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  return dialogs;
};

/** Picks a mode and presses the button; returns the in-page confirmation. */
async function startDemoFromShell(page: Page, button: 'Start demo' | 'Add the demo', mode: 'Replay' | 'Live') {
  const controls = page.getByRole('group', { name: 'Demo' });
  await controls.getByRole('radio', { name: mode }).check();
  await controls.getByRole('button', { name: button }).click();
  const confirm = page.getByRole('alertdialog', { name: `${button}?` });
  await confirm.waitFor();
  return confirm;
}

async function eventuallyDemo(kiln: TestKiln, accept: (s: DemoState) => boolean): Promise<DemoState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await kiln.api<DemoState>('GET', '/api/demo');
    if (accept(state)) return state;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the demo: ${JSON.stringify(state)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

test('on a dev instance the all-Projects view offers "Add the demo"; it adds the demo in Replay, with the Replay note, and the button shows on the demo Project only', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  const other = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path, name: 'Other' });
  const page = await openShell(t, kiln);
  const dialogs = noBrowserDialogs(page);
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));

  const confirm = await startDemoFromShell(page, 'Add the demo', 'Replay');
  await confirm.getByText(/Replay/).first().waitFor();
  await confirm.getByRole('button', { name: 'Add the demo' }).click();

  await page.getByRole('heading', { name: 'Demo' }).waitFor();
  await card(page, 'Story Grill', DEMO_STORY).waitFor();
  const note = page.getByRole('note', { name: 'Replay' });
  await note.getByText(/answer the Asks in Needs you/i).waitFor();
  await note.getByText(/approve the Gates/i).waitFor();
  await note.getByText(/Ticket 01.*Review.*ship.*Ticket 02/i).waitFor();
  await page.getByRole('group', { name: 'Demo' }).getByRole('button', { name: 'Start demo' }).waitFor();

  await page.getByRole('link', { name: 'All Projects' }).click();
  await page.getByRole('link', { name: 'Demo', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Add the demo' }).count(), 0);

  await page.getByRole('link', { name: other.name, exact: true }).first().click();
  await page.getByRole('heading', { name: 'Other' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Start demo' }).count(), 0);
  assert.equal(await page.getByRole('note', { name: 'Replay' }).count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded), true);
  assert.deepEqual(dialogs, []);
});

test('"Start demo" throws the run away for a fresh one in the chosen mode; Cancel keeps it, and a Live refusal shows next to the button', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  const first = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });
  const page = await openShell(t, kiln, `/projects/${first.projectId}`);
  const dialogs = noBrowserDialogs(page);
  await card(page, 'Story Grill', DEMO_STORY).waitFor();
  await page.getByRole('note', { name: 'Replay' }).waitFor();
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));

  let confirm = await startDemoFromShell(page, 'Start demo', 'Live');
  await confirm.getByText(/thrown away/i).waitFor();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), first);

  // Live with no role models is refused, and the refusal sits next to the button.
  confirm = await startDemoFromShell(page, 'Start demo', 'Live');
  await confirm.getByRole('button', { name: 'Start demo' }).click();
  await page.getByRole('group', { name: 'Demo' }).getByRole('alert').filter({ hasText: /griller/ }).waitFor();
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), first);

  // The Replay run put `fake-model` in its own Budget, so Live gets another model.
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['live-model'] });
  await kiln.api('PUT', '/api/setup', { roles: Object.fromEntries(ROLES.map((role) => [role, { model: 'live-model' }])) });
  confirm = await startDemoFromShell(page, 'Start demo', 'Live');
  await confirm.getByRole('button', { name: 'Start demo' }).click();

  const second = await eventuallyDemo(kiln, (s) => s.mode === 'live');
  assert.notEqual(second.projectId, first.projectId);
  await page.waitForURL((url) => url.pathname === `/projects/${second.projectId}`);
  await card(page, 'Story Grill', DEMO_STORY).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Demo' }).getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('note', { name: 'Replay' }).count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded), true);
  assert.deepEqual(dialogs, []);
});

test('when the Widget source policy refuses the fake Agent, "Add the demo" shows its message next to the button', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await kiln.api('PUT', '/api/org-policy/widget-sources', { allowed: ['https://github.com/kiln-widgets/*'] });
  const page = await openShell(t, kiln);

  const confirm = await startDemoFromShell(page, 'Add the demo', 'Replay');
  await confirm.getByRole('button', { name: 'Add the demo' }).click();

  await page.getByRole('group', { name: 'Demo' }).getByRole('alert').filter({ hasText: /Org Policy does not allow installing/ }).waitFor();
  await page.getByRole('button', { name: 'Add the demo' }).waitFor();
});

test('a live instance offers no demo, on the all-Projects view or a Project', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: project.name }).first().waitFor();
  assert.equal(await page.getByRole('group', { name: 'Demo' }).count(), 0);

  await page.getByRole('link', { name: project.name }).first().click();
  await page.getByRole('heading', { name: project.name }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Demo' }).count(), 0);
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
