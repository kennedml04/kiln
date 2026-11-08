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
import { createTempRepo, startTestKiln, type EventStream, type FakeAgent, type FakeAgentScript, type TestKiln } from '@kiln/testing';
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

  assert.deepEqual(results.map((r) => r.queued), [false, false, true, true]);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'running', 'up-next', 'up-next']);
  const state = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(state.pools, [{ name: 'agents', size: 3, active: 2 }]);
  assert.deepEqual(state.queue.map((q) => q.itemId), [tickets[2]!.id, tickets[3]!.id]);
  // One Story never holds every slot of the pool.
  assert.equal(state.queue[0]!.held, 'Story already holds its share of the pool');

  for (let i = 0; i < 2; i++) await events.next('session.started', { timeoutMs: 15_000 });
  await agent.stopSession(results[0]!.session!.id);
  const third = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 15_000 });

  assert.equal(third.payload.itemId, tickets[2]!.id);
  assert.deepEqual(await runStates(kiln, titles), ['backlog', 'running', 'running', 'up-next']);
});

test('an Admin changes a pool\'s size and it takes effect at once, without a restart', async (t) => {
  const titles = ['One', 'Two', 'Three'];
  const { kiln, tickets, events } = await setup(t, titles);
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  for (const ticket of tickets) await start(kiln, ticket);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'up-next', 'up-next']);

  const grown = await kiln.api<SchedulerState>('PUT', '/api/scheduler/pools/agents', { size: 3 });
  assert.deepEqual(grown.pools, [{ name: 'agents', size: 3, active: 2 }]);
  assert.deepEqual(await runStates(kiln, titles), ['running', 'running', 'up-next']);
  await events.next('session.started', { timeoutMs: 15_000 });
  await events.next('session.started', { timeoutMs: 15_000 });

  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/agents', { size: -1 }), /400/);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1.5 }), /400/);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/pools/nope', { size: 2 }), /404/);
});

/** Makes a Story of the seeded Project (by the first seeded Ticket's Project) with one Ticket each. */
async function ticketsOfOwnStories(kiln: TestKiln, projectId: string, titles: string[]): Promise<Item[]> {
  const tickets: Item[] = [];
  for (const title of titles) {
    const story = await kiln.api<Item>('POST', `/api/projects/${projectId}/items`, { kind: 'story', title: `Story ${title}` });
    tickets.push(await kiln.api<Item>('POST', `/api/projects/${projectId}/items`, { kind: 'ticket', title, parentId: story.id }));
  }
  return tickets;
}

test('Up next starts Stories oldest first until a person reorders them by Story id or Ticket id; then that order wins', async (t) => {
  const { kiln, tickets: seeded, events } = await setup(t, ['Running']);
  const [running] = seeded as [Item];
  const [b, c, d] = await ticketsOfOwnStories(kiln, running.projectId, ['B', 'C', 'D']) as [Item, Item, Item];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 0 });
  for (const ticket of [b, c, d]) await start(kiln, ticket);
  const queueOf = (state: SchedulerState) => state.queue.map((q) => q.itemId);
  assert.deepEqual(queueOf(await kiln.api<SchedulerState>('GET', '/api/scheduler')), [b.id, c.id, d.id]);

  // A Story id moves its Story's Tickets; a Ticket id does the same (one-release shim).
  const reordered = await kiln.api<SchedulerState>('PUT', '/api/scheduler/queue', { order: [d.parentId, b.id, c.id] });
  assert.deepEqual(queueOf(reordered), [d.id, b.id, c.id]);
  let update: SchedulerUpdatedEvent;
  do update = await events.next<SchedulerUpdatedEvent>('scheduler.updated');
  while (queueOf(update.payload).join() !== [d.id, b.id, c.id].join());

  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 1 });
  const next = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 15_000 });
  assert.equal(next.payload.itemId, d.id);
  assert.deepEqual(queueOf(await kiln.api<SchedulerState>('GET', '/api/scheduler')), [b.id, c.id]);

  await assert.rejects(kiln.api('PUT', '/api/scheduler/queue', { order: ['nope/none'] }), /409/);
});

test('reorder with a projectId moves only that Project Stories within their own places; other Projects Stories are a 400', async (t) => {
  const { kiln, tickets: seeded } = await setup(t, ['Running']);
  const projectA = seeded[0]!.projectId;
  const repoB = createTempRepo(t);
  const projectB = (await kiln.api<Project>('POST', '/api/projects', { path: repoB.path })).id;
  const [a1, a2] = await ticketsOfOwnStories(kiln, projectA, ['A1', 'A2']) as [Item, Item];
  const [b1] = await ticketsOfOwnStories(kiln, projectB, ['B1']) as [Item];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 0 });
  // Order of joining: A1, B1, A2.
  for (const ticket of [a1, b1, a2]) await start(kiln, ticket);
  const queueOf = (state: SchedulerState) => state.queue.map((q) => q.itemId);

  const swapped = await kiln.api<SchedulerState>('PUT', '/api/scheduler/queue', { order: [a2.parentId, a1.parentId], projectId: projectA });
  assert.deepEqual(queueOf(swapped), [a2.id, b1.id, a1.id]);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/queue', { order: [b1.parentId], projectId: projectA }), /400/);
  await assert.rejects(kiln.api('PUT', '/api/scheduler/queue', { order: [a1.parentId], projectId: 'other' }), /400/);
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
  // Three slots: the Tickets' one Story may hold two of them.
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 3 });
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

test('Story limits default to 2 per Project; only an Admin sets one, whole numbers 0-10; raising it is visible in the state', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const mo = kiln.as('mo');
  const url = `/api/scheduler/story-limits/${project.id}`;

  const before = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.equal(before.limits.perProject[project.id], 2);
  assert.equal(typeof before.limits.boxWide, 'number');

  assert.equal((await mo.request('PUT', url, { limit: 3 })).status, 403);
  assert.equal((await kiln.request('PUT', url, { limit: 11 })).status, 400);
  assert.equal((await kiln.request('PUT', url, { limit: 1.5 })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/scheduler/story-limits/nope', { limit: 3 })).status, 404);

  const after = await kiln.api<SchedulerState>('PUT', url, { limit: 4 });
  assert.equal(after.limits.perProject[project.id], 4);
  assert.equal((await kiln.api<SchedulerState>('GET', '/api/scheduler')).limits.perProject[project.id], 4);
});
