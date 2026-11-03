import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { CoreStatus, Item, Project, SchedulerState, SessionInfo } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

const column = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const card = (page: Page, columnName: string, title: string) =>
  column(page, columnName).getByRole('article', { name: title, exact: true });

async function seedTickets(kiln: TestKiln, titles: string[]): Promise<Item[]> {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const story = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Home board')!;
  const tickets: Item[] = [];
  for (const title of titles) {
    tickets.push(await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id }));
  }
  return tickets;
}

const start = (kiln: TestKiln, item: Item) => kiln.api('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

test('Stop all asks first, then pauses the running work and the queue; Resume continues it', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'tool', name: 'think', times: 'forever', intervalMs: 20 }] });
  const [running, waiting] = await seedTickets(kiln, ['Keep going', 'Wait your turn']);
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  await start(kiln, running!);
  await start(kiln, waiting!);
  const page = await openShell(t, kiln);
  await card(page, 'Running', 'Keep going').waitFor();
  await card(page, 'Up next', 'Wait your turn').waitFor();

  await page.getByRole('button', { name: 'Stop all' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Stop all?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await kiln.api<SchedulerState>('GET', '/api/scheduler')).paused, false);

  await page.getByRole('button', { name: 'Stop all' }).click();
  await confirm.getByRole('button', { name: 'Stop everything' }).click();

  await page.getByRole('status').filter({ hasText: 'Everything is stopped' }).waitFor();
  await card(page, 'Running', 'Keep going').getByText('Paused').waitFor();
  await card(page, 'Up next', 'Wait your turn').waitFor();
  const [session] = await kiln.api<SessionInfo[]>('GET', `/api/sessions?item=${encodeURIComponent(running!.id)}`);
  assert.equal(session?.state, 'paused');

  await page.getByRole('button', { name: 'Resume' }).click();

  await page.getByRole('button', { name: 'Stop all' }).waitFor();
  await card(page, 'Running', 'Keep going').getByText('Paused').waitFor({ state: 'detached' });
  const [after] = await kiln.api<SessionInfo[]>('GET', `/api/sessions?item=${encodeURIComponent(running!.id)}`);
  assert.equal(after?.state, 'running');
});

test('dragging within Up next changes the start order, and the board shows it live', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const [first, ...queued] = await seedTickets(kiln, ['Busy', 'Older', 'Newer']);
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  for (const ticket of [first!, ...queued]) await start(kiln, ticket);
  const page = await openShell(t, kiln);
  const order = () => column(page, 'Up next').getByRole('article').evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label')));
  await card(page, 'Up next', 'Newer').waitFor();
  assert.deepEqual(await order(), ['Older', 'Newer']);

  await card(page, 'Up next', 'Newer').dragTo(card(page, 'Up next', 'Older'));

  await page.waitForFunction(() => {
    const cards = document.querySelectorAll('[aria-label="Up next"] article');
    return cards[0]?.getAttribute('aria-label') === 'Newer';
  });
  assert.deepEqual(await order(), ['Newer', 'Older']);
  const state = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(state.queue.map((q) => q.itemId), [queued[1]!.id, queued[0]!.id]);
});

test('an Admin changes a pool\'s size in Settings', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'Settings' }).click();
  const size = page.getByRole('spinbutton', { name: 'agents pool size' });
  await size.fill('5');
  await page.getByRole('button', { name: 'Save agents' }).click();

  await page.getByRole('status').filter({ hasText: 'agents: 5' }).waitFor();
  assert.equal((await kiln.api<SchedulerState>('GET', '/api/scheduler')).pools[0]!.size, 5);
});

test('an Admin asks for Restart when idle in Settings, sees it wait for the running Session, and calls it off', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const [ticket] = await seedTickets(kiln, ['Keep going']);
  await start(kiln, ticket!);
  const before = await kiln.api<CoreStatus>('GET', '/api/status');
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Restart when idle' }).click();

  await page.getByRole('status').filter({ hasText: 'Restart when idle: waiting for 1 running Session' }).waitFor();
  assert.equal((await kiln.api<CoreStatus>('GET', '/api/status')).restartPending?.runningSessions, 1);
  await page.getByRole('button', { name: 'Call off the restart' }).click();

  await page.getByRole('button', { name: 'Restart when idle' }).waitFor();
  const after = await kiln.api<CoreStatus>('GET', '/api/status');
  assert.equal(after.restartPending, undefined);
  assert.equal(after.pid, before.pid);
});
