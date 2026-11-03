// The local Budget: models served on this machine. No money; each Session is capped by turns and
// wall time, and local Sessions take a slot in the gpu pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  BudgetInfo,
  BudgetLimitReachedEvent,
  BudgetsUpdatedEvent,
  Item,
  KilnEvent,
  Project,
  SchedulerState,
  SessionInfo,
  SessionStartedEvent,
  StartResult,
  UsageRecord,
  UsageRecordedEvent,
} from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

type Events = Awaited<ReturnType<TestKiln['events']>>;

/** Registers the seeded Project; returns its ready Ticket and a way to add more. */
async function seedProject(kiln: TestKiln) {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = items.find((i) => i.title === 'Home board')!;
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const addTicket = (title: string) => kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id });
  return { project, ticket, addTicket };
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

/** A Kiln whose fake Agent's model (`fake-model`) draws from a local Budget named "Home GPU". */
async function setup(t: Parameters<typeof startTestKiln>[0], script: FakeAgentScript, budget: Record<string, unknown> = {}) {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script });
  await kiln.api<BudgetInfo>('PUT', '/api/budgets/home', { kind: 'local', name: 'Home GPU', models: ['fake-model'], ...budget });
  const seeded = await seedProject(kiln);
  const events = await kiln.events();
  return { kiln, agent, events, ...seeded };
}

async function nextWhere<E extends KilnEvent>(events: Events, type: E['type'], match: (e: E) => boolean) {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs: 15_000 });
    if (match(event)) return event;
  }
}

test('a local Budget defaults to 300 turns or 2 hours per Session, and its turns cost no money', async (t) => {
  const { kiln, events, ticket } = await setup(t, [
    { do: 'usage', model: 'fake-model', inputTokens: 1_000, outputTokens: 200 },
    { do: 'wait_for_message' },
  ]);
  const [home] = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.equal(home!.kind, 'local');
  assert.deepEqual(home!.config, { perSession: { turns: 300, minutes: 120 } });
  assert.equal(home!.unit, 'turns');

  const { session } = await start(kiln, ticket);
  await events.next<UsageRecordedEvent>('usage.recorded', { timeoutMs: 15_000 });
  const [record] = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${session!.id}`);
  assert.equal(record!.budgetId, 'home');
  assert.equal(record!.unit, 'turns');
  assert.equal(record!.cost, 1, 'a turn costs one turn of its cap');
  assert.equal(record!.costUsd, null, 'no money, and none estimated');
  assert.equal(record!.outputTokens, 200);

  const item = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === ticket.id)!;
  assert.deepEqual([item.run?.usage?.cost, item.run?.usage?.unit, item.run?.usage?.alerts], [1, 'turns', []]);
});

test('the local turn cap counts subagent turns and pauses the Session on a blocking Ask', async (t) => {
  const { kiln, events, ticket } = await setup(
    t,
    [
      { do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50 },
      { do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, subagent: { description: 'Read the docs' } },
      { do: 'wait_for_message' },
    ],
    { perSession: { turns: 2 } },
  );
  const { session } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.deepEqual([reached.payload.limit.id, reached.payload.limit.used, reached.payload.limit.cap, reached.payload.limit.unit], ['session-turns', 2, 2, 'turns']);
  assert.deepEqual(reached.payload.paused, [session!.id]);
  assert.equal((await kiln.api<Ask>('GET', `/api/asks/${reached.payload.askId}`)).blocking, true);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`)).state, 'waiting');
});

test('local Sessions take a slot in the gpu pool as well as their Stage\'s, so with "gpu: 1" they never run two at a time', async (t) => {
  // No GPU monitor is installed: the local Budget brings the gpu pool itself, on any machine.
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [{ do: 'wait_for_message' }]);
  const second = await addTicket('Second');

  const first = await start(kiln, ticket);
  const queued = await start(kiln, second);
  assert.equal(first.queued, false);
  assert.equal(queued.queued, true, 'the agents pool has room, the gpu pool has none');
  const state = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(state.pools, [
    { name: 'agents', size: 3, active: 1 },
    { name: 'gpu', size: 1, active: 1 },
  ]);
  assert.deepEqual(state.queue.map((q) => q.itemId), [second.id]);

  await agent.stopSession(first.session!.id);
  const next = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === second.id);
  assert.equal(next.payload.session.state, 'running');
});

test("local work keeps going while a metered Budget's monthly limit pauses its own work", async (t) => {
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [
    { do: 'usage', model: 'cloud-model', inputTokens: 100, outputTokens: 50, costUsd: 0.2 },
    { do: 'wait_for_message' },
  ]);
  await kiln.api('PUT', '/api/budgets/work', { kind: 'metered', name: 'Work', models: ['cloud-model'], monthly: 10 });
  // Both Sessions plan the fake Agent's local model, so make room for two in the gpu pool.
  await kiln.api('PUT', '/api/scheduler/pools/gpu', { size: 2 });

  const { session: cloud } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.deepEqual([reached.payload.budgetId, reached.payload.limit.id, reached.payload.paused], ['work', 'month', [cloud!.id]]);

  agent.setScript([{ do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, times: 2 }, { do: 'wait_for_message' }]);
  const local = await start(kiln, await addTicket('Local work'));
  assert.equal(local.queued, false, 'not held by the paused metered Budget');
  const turns = [];
  for (let i = 0; i < 2; i++) {
    turns.push(await nextWhere<UsageRecordedEvent>(events, 'usage.recorded', (e) => e.payload.sessionId === local.session!.id));
  }
  assert.deepEqual(turns.map((e) => e.payload.record.budgetId), ['home', 'home']);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${local.session!.id}`)).state, 'running');
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${cloud!.id}`)).state, 'waiting');
  const budgets = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.deepEqual(budgets.map((b) => [b.id, b.held]), [['home', false], ['work', true]]);
});

test("a local Budget's gauge counts its running Sessions, and updates as they start and end", async (t) => {
  const { kiln, agent, events, ticket } = await setup(t, [{ do: 'wait_for_message' }]);
  const gauge = async () => (await kiln.api<BudgetInfo[]>('GET', '/api/budgets'))[0]!.gauge;
  assert.deepEqual(await gauge(), { label: 'No Sessions running', used: 0, cap: 1, unit: 'Sessions' });

  const { session } = await start(kiln, ticket);
  const running = await nextWhere<BudgetsUpdatedEvent>(events, 'budgets.updated', (e) => e.payload.budgets[0]!.gauge.used === 1);
  assert.deepEqual(running.payload.budgets[0]!.gauge, { label: '1 Session running', used: 1, cap: 1, unit: 'Sessions' });

  await agent.stopSession(session!.id);
  await nextWhere<BudgetsUpdatedEvent>(events, 'budgets.updated', (e) => e.payload.budgets[0]!.gauge.used === 0);
});

const advance = (kiln: TestKiln, ms: number) => kiln.api<{ now: string }>('POST', '/api/test/clock', { advanceMs: ms });
const MINUTE = 60_000;

test('two hours of wall time pause a local Session on a blocking Ask, even between turns; Continue allows two more', async (t) => {
  const { kiln, events, ticket } = await setup(t, [
    { do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50 },
    { do: 'wait_for_message' },
  ]);
  await kiln.api('POST', '/api/test/clock', { now: '2026-03-04T10:00:00' });
  const { session } = await start(kiln, ticket);
  await events.next('usage.recorded', { timeoutMs: 15_000 });

  await advance(kiln, 61 * MINUTE);
  const item = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === ticket.id)!;
  assert.deepEqual(
    item.run?.usage?.alerts.map((a) => [a.id, a.level, a.used, a.cap, a.unit]),
    [['session-time', 'warning', 61, 120, 'minutes']],
    'warned at half the time',
  );

  await advance(kiln, 59 * MINUTE);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.equal(reached.payload.scope, 'session');
  assert.deepEqual([reached.payload.limit.id, reached.payload.limit.used, reached.payload.limit.cap, reached.payload.limit.unit], ['session-time', 120, 120, 'minutes']);
  assert.deepEqual(reached.payload.paused, [session!.id]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${reached.payload.askId}`);
  assert.equal(ask.blocking, true);
  assert.deepEqual(ask.raisedBy, { kind: 'budget', budgetId: 'home' });
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`)).state, 'waiting', 'paused, not killed');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Continue' });
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`)).state, 'running');
  await advance(kiln, 120 * MINUTE);
  const again = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.deepEqual([again.payload.limit.used, again.payload.limit.cap], [240, 240]);
});
