import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreStatus, Item, Project, RestartPending, StartResult, WidgetInfo } from '@kiln/widget-sdk';
import { createWidgetSource, startTestKiln, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls until `check` returns a value, or fails after `timeoutMs`. */
async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/** Waits until a core other than `pid` answers on the test core's port. */
const restartedCore = (kiln: TestKiln, pid: number) =>
  eventually('the restarted core', async () => {
    const status = await kiln.api<CoreStatus>('GET', '/api/status');
    return status.pid !== pid ? status : undefined;
  });

test('Restart when idle with no running Sessions restarts the core at once, and approved Widgets come back', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent();
  const before = await kiln.api<CoreStatus>('GET', '/api/status');

  const reply = await kiln.request('POST', '/api/core/restart-when-idle');
  const after = await restartedCore(kiln, before.pid);
  const fakeAgent = await eventually('the fake Agent to be ready again', async () => {
    const widgets = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
    return widgets.find((w) => w.id === 'fake-agent' && w.state === 'ready');
  });

  assert.equal(reply.status, 202);
  assert.equal(after.port, before.port);
  assert.equal(after.dataDir, before.dataDir);
  assert.ok(fakeAgent.grants, 'the approval survives the restart');
});

test('Restart when idle waits for running Sessions to finish, starts no new ones meanwhile, then restarts', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'stopped' }] });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', '/api/items');
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const story = items.find((i) => i.title === 'Home board')!;
  const another = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title: 'Another', parentId: story.id });
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const before = await kiln.api<CoreStatus>('GET', '/api/status');

  const pending = await kiln.api<RestartPending>('POST', '/api/core/restart-when-idle');
  await sleep(500);
  const whileWaiting = await kiln.api<CoreStatus>('GET', '/api/status');
  const refused = await kiln.request<{ error: string }>('POST', `/api/items/${encodeURIComponent(another.id)}/start`);
  await agent.sendMessage(session!.id, { kind: 'text', text: 'wrap up' });
  const after = await restartedCore(kiln, before.pid);

  assert.equal(pending.runningSessions, 1);
  assert.equal(whileWaiting.pid, before.pid, 'the core must not restart while a Session runs');
  assert.equal(whileWaiting.restartPending?.runningSessions, 1);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /restart/i);
  assert.equal(after.restartPending, undefined);
});

test('Items waiting in Up next keep their place through Restart when idle and start after it', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'stopped' }] });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const story = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Home board')!;
  const ticket = (title: string) =>
    kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id });
  const [first, waiting] = [await ticket('First'), await ticket('Waiting')];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  const started = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(first.id)}/start`);
  const queued = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(waiting.id)}/start`);
  const before = await kiln.api<CoreStatus>('GET', '/api/status');

  await kiln.api('POST', '/api/core/restart-when-idle');
  await agent.sendMessage(started.session!.id, { kind: 'text', text: 'wrap up' });
  await restartedCore(kiln, before.pid);
  const runState = await eventually('the waiting Item to start after the restart', async () => {
    const item = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === waiting.id);
    return item?.runState === 'running' ? item.runState : undefined;
  });

  assert.equal(queued.queued, true);
  assert.equal(runState, 'running');
});

test('Restart when idle can be called off while it waits', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'stopped' }] });
  seedScratch(kiln.repo);
  await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Draw the columns')!;
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);

  await kiln.api('POST', '/api/core/restart-when-idle');
  const cancelled = await kiln.request('DELETE', '/api/core/restart-when-idle');
  const status = await kiln.api<CoreStatus>('GET', '/api/status');

  assert.equal(cancelled.status, 200);
  assert.equal(status.restartPending, undefined);
});

test('No Widget can restart or stop the live core, whatever it was granted', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t, { manifest: { needs: { work: [{ access: 'write', projects: '*' }] } } });
  await kiln.api('POST', '/api/widgets', { source: source.path });
  const widget = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/approve');
  const events = await kiln.events();
  await eventually('the test Widget to be ready', async () =>
    (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === widget.id && w.state === 'ready'),
  );
  const before = await kiln.api<CoreStatus>('GET', '/api/status');

  for (const [method, path] of [['POST', '/api/core/restart-when-idle'], ['POST', '/api/core/stop']] as const) {
    await kiln.api('POST', `/api/test/widgets/${widget.id}/commands`, { type: 'test.call', method, path });
  }
  const calls = await eventually('both Widget calls to be logged', async () => {
    const log = join(kiln.dataDir, 'widgets', widget.id, 'data', 'calls.jsonl');
    if (!existsSync(log)) return undefined;
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { path: string; status: number });
    return lines.length >= 2 ? lines : undefined;
  });
  const after = await kiln.api<CoreStatus>('GET', '/api/status');
  events.close();

  assert.deepEqual(calls.map((c) => c.status), [403, 403]);
  assert.equal(after.pid, before.pid);
  assert.equal(after.restartPending, undefined);
});
