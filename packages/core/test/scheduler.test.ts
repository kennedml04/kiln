import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type {
  Item,
  Project,
  SchedulerState,
  SchedulerUpdatedEvent,
  SessionAgentEvent,
  SessionStartedEvent,
  SessionUpdatedEvent,
  StartResult,
} from '@kiln/widget-sdk';
import { startTestKiln, type EventStream, type FakeAgent, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

/** A seeded Project plus `count` Tickets of its Story, all in Implementing. */
async function seedTickets(kiln: TestKiln, titles: string[]): Promise<Item[]> {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = items.find((i) => i.title === 'Home board')!;
  const tickets: Item[] = [];
  for (const title of titles) {
    tickets.push(await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id }));
  }
  return tickets;
}

const start = (kiln: TestKiln, item: Item) =>
  kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

const runStates = async (kiln: TestKiln, titles: string[]) => {
  const items = await kiln.api<Item[]>('GET', '/api/items');
  return titles.map((title) => items.find((i) => i.title === title)!.runState);
};

/** A Session that keeps running until the test stops it. */
const WAIT = [{ do: 'wait_for_message' as const }];

async function setup(t: Parameters<typeof startTestKiln>[0], titles: string[], script: FakeAgentScript = WAIT) {
  const kiln = await startTestKiln(t);
  const agent: FakeAgent = await kiln.installFakeAgent({ script });
  const tickets = await seedTickets(kiln, titles);
  const events = await kiln.events();
  return { kiln, agent, tickets, events };
}

test('no more Sessions run at once than the default "agents: 3" pool allows; the rest wait in Up next', async (t) => {
  const titles = ['One', 'Two', 'Three', 'Four'];
  const { kiln, agent, tickets, events } = await setup(t, titles);

  const results: StartResult[] = [];
  for (const ticket of tickets) results.push(await start(kiln, ticket));

  assert.deepEqual(results.map((r) => r.queued), [false, false, false, true]);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'running', 'running', 'up-next']);
  const state = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(state.pools, [{ name: 'agents', size: 3, active: 3 }]);
  assert.deepEqual(state.queue.map((q) => q.itemId), [tickets[3]!.id]);

  for (let i = 0; i < 3; i++) await events.next('session.started', { timeoutMs: 15_000 });
  await agent.stopSession(results[0]!.session!.id);
  const fourth = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 15_000 });

  assert.equal(fourth.payload.itemId, tickets[3]!.id);
  assert.deepEqual(await runStates(kiln, titles), ['backlog', 'running', 'running', 'running']);
});

test('an Admin changes a pool\'s size and it takes effect at once, without a restart', async (t) => {
  const titles = ['One', 'Two', 'Three'];
  const { kiln, tickets, events } = await setup(t, titles);
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  for (const ticket of tickets) await start(kiln, ticket);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'up-next', 'up-next']);

  const grown = await kiln.api<SchedulerState>('PUT', '/api/scheduler/pools/agents', { size: 2 });
  assert.deepEqual(grown.pools, [{ name: 'agents', size: 2, active: 2 }]);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'running', 'up-next']);
  await events.next('session.started', { timeoutMs: 15_000 });
  await events.next('session.started', { timeoutMs: 15_000 });

  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/agents', { size: -1 }), /400/);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1.5 }), /400/);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/nope', { size: 2 }), /404/);
});

test('Up next starts oldest first until a person reorders it; then the order they set wins', async (t) => {
  const titles = ['Running', 'B', 'C', 'D'];
  const { kiln, agent, tickets, events } = await setup(t, titles);
  const [running, b, c, d] = tickets as [Item, Item, Item, Item];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  const first = await start(kiln, running);
  for (const ticket of [b, c, d]) await start(kiln, ticket);
  const queueOf = (state: SchedulerState) => state.queue.map((q) => q.itemId);
  assert.deepEqual(queueOf(await kiln.api<SchedulerState>('GET', '/api/scheduler')), [b.id, c.id, d.id]);

  const reordered = await kiln.api<SchedulerState>('PUT', '/api/scheduler/queue', { order: [d.id, b.id, c.id] });
  assert.deepEqual(queueOf(reordered), [d.id, b.id, c.id]);
  let update: SchedulerUpdatedEvent;
  do update = await events.next<SchedulerUpdatedEvent>('scheduler.updated');
  while (queueOf(update.payload).join() !== [d.id, b.id, c.id].join());

  await events.next('session.started', { timeoutMs: 15_000 });
  await agent.stopSession(first.session!.id);
  const next = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 15_000 });
  assert.equal(next.payload.itemId, d.id);
  assert.deepEqual(queueOf(await kiln.api<SchedulerState>('GET', '/api/scheduler')), [b.id, c.id]);

  await assert.rejects(kiln.api('PUT', '/api/scheduler/queue', { order: [running.id] }), /409/);
});

/** Waits for the next event of `type` whose payload passes `match`. */
async function nextWhere<E extends SessionUpdatedEvent | SessionAgentEvent | SessionStartedEvent>(
  events: EventStream,
  type: E['type'],
  match: (e: E) => boolean,
): Promise<E> {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs: 15_000 });
    if (match(event)) return event;
  }
}

test('Stop all pauses every running Session and the queue without killing anything; resuming continues the work', async (t) => {
  const titles = ['A', 'B', 'C'];
  const { kiln, agent, tickets, events } = await setup(t, titles, [
    { do: 'tool', name: 'think', times: 200, intervalMs: 20 },
  ]);
  const [a, b, c] = tickets as [Item, Item, Item];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 2 });
  const sessionA = (await start(kiln, a)).session!;
  const sessionB = (await start(kiln, b)).session!;
  await start(kiln, c);

  const stopped = await kiln.api<SchedulerState>('POST', '/api/scheduler/stop-all');

  assert.equal(stopped.paused, true);
  // Both Sessions stop at their next checkpoint, in either order.
  const unfinished = new Set([sessionA.id, sessionB.id]);
  while (unfinished.size) {
    const finished = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 15_000 });
    unfinished.delete(finished.payload.sessionId);
  }
  const items = await kiln.api<Item[]>('GET', '/api/items');
  const runOf = (item: Item) => items.find((i) => i.id === item.id)!.run?.state;
  assert.deepEqual([runOf(a), runOf(b)], ['paused', 'paused']);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'running', 'up-next']);
  assert.ok(existsSync(sessionA.worktree!), 'a paused Session keeps its worktree');

  // A slot frees up while stopped: nothing new starts.
  await agent.stopSession(sessionB.id);
  await nextWhere<SessionUpdatedEvent>(events, 'session.updated', (e) => e.payload.session.id === sessionB.id && e.payload.session.state === 'stopped');
  const held = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(held.queue.map((q) => q.itemId), [c.id]);
  assert.equal(held.paused, true);

  const resumed = await kiln.api<SchedulerState>('POST', '/api/scheduler/resume');

  assert.equal(resumed.paused, false);
  const startedC = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === c.id);
  assert.ok(startedC);
  await nextWhere<SessionAgentEvent<'progress'>>(events, 'session.progress', (e) => e.payload.sessionId === sessionA.id);
  const items2 = await kiln.api<Item[]>('GET', '/api/items');
  assert.equal(items2.find((i) => i.id === a.id)!.run?.state, 'running');
});

test('only an Admin can change a pool\'s size', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  const refused = await kiln.as('mo').request('PUT', '/api/scheduler/pools/agents', { size: 9 });

  assert.equal(refused.status, 403);
  assert.equal((await kiln.api<SchedulerState>('GET', '/api/scheduler')).pools[0]!.size, 3);
});
