import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  AskRaisedEvent,
  BudgetInfo,
  BudgetLimitReachedEvent,
  Item,
  KilnEvent,
  SessionStartedEvent,
  SessionUpdatedEvent,
  Project,
  SessionInfo,
  StartResult,
  UsageRecord,
  UsageRecordedEvent,
  UsageRollup,
} from '@kiln/widget-sdk';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeWidgetRepo, startTestKiln, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Runs the `kiln` CLI and returns its exit code and output. */
const cli = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, KILN_PORT: undefined, KILN_DATA_DIR: undefined, KILN_LOGIN: undefined } },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

/** Registers the seeded Project; returns it, its Epic and the ready Ticket ("Draw the columns"). */
async function seedProject(kiln: TestKiln) {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const epic = items.find((i) => i.kind === 'epic')!;
  const story = items.find((i) => i.title === 'Home board')!;
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const addTicket = (title: string) => kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id });
  return { project, epic, ticket, addTicket };
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

async function setup(t: Parameters<typeof startTestKiln>[0], script: FakeAgentScript, budget: Record<string, unknown> = {}) {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script });
  await kiln.api<BudgetInfo>('PUT', '/api/budgets/work', { kind: 'metered', name: 'Work', models: ['fake-model', 'fake-small'], ...budget });
  const seeded = await seedProject(kiln);
  const events = await kiln.events();
  return { kiln, agent, events, ...seeded };
}

test('every reported turn is stored with all its fields, and subagent turns roll up to their parent Session and Item', async (t) => {
  const { kiln, events, epic, ticket } = await setup(t, [
    { do: 'usage', model: 'fake-model', inputTokens: 1_000, cacheReadTokens: 20_000, cacheWriteTokens: 3_000, outputTokens: 500, costUsd: 0.4 },
    { do: 'usage', model: 'fake-small', inputTokens: 200, outputTokens: 100, costUsd: 0.1, subagent: { description: 'Research the API' } },
    { do: 'wait_for_message' },
  ]);

  const { session } = await start(kiln, ticket);
  await events.next<UsageRecordedEvent>('usage.recorded', { timeoutMs: 15_000 });
  await events.next<UsageRecordedEvent>('usage.recorded', { timeoutMs: 15_000 });
  const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${session!.id}`);

  assert.equal(records.length, 2);
  const [main, sub] = records as [UsageRecord, UsageRecord];
  assert.equal(main.sessionId, session!.id);
  assert.equal(main.parentSessionId, null);
  assert.equal(main.subagent, null);
  assert.equal(main.itemId, ticket.id);
  assert.equal(main.epicId, epic.id);
  assert.equal(main.stage, 'implementing');
  assert.equal(main.itemKind, 'ticket');
  assert.equal(main.model, 'fake-model');
  assert.equal(main.budgetId, 'work');
  assert.equal(main.turn, 1);
  assert.equal(main.contextTokens, 24_000);
  assert.equal(main.inputTokens, 1_000);
  assert.equal(main.cacheReadTokens, 20_000);
  assert.equal(main.cacheWriteTokens, 3_000);
  assert.equal(main.outputTokens, 500);
  assert.equal(main.cost, 20, '$0.40 at 50 credits per dollar');
  assert.equal(main.unit, 'credits');
  assert.equal(main.costUsd, 0.4);
  assert.ok(main.idleMs >= 0);

  assert.equal(sub.sessionId, `${session!.id}/Research the API`);
  assert.equal(sub.parentSessionId, session!.id);
  assert.equal(sub.subagent, 'Research the API');
  assert.equal(sub.cost, 5);

  const bySession = await kiln.api<UsageRollup[]>('GET', '/api/usage?by=session');
  assert.deepEqual(
    bySession.map((r) => [r.key, r.turns, r.cost, r.outputTokens]),
    [[session!.id, 2, 25, 600]],
  );
  const byItem = await kiln.api<UsageRollup[]>('GET', '/api/usage?by=item');
  assert.deepEqual(byItem.map((r) => [r.key, r.cost, r.unit]), [[ticket.id, 25, 'credits']]);
});

/** Waits for the Session to reach a state (from `session.updated` events). */
async function sessionState(events: Awaited<ReturnType<TestKiln['events']>>, id: string, state: string) {
  for (;;) {
    const event = await events.next<SessionUpdatedEvent>('session.updated', { timeoutMs: 15_000 });
    if (event.payload.session.id === id && event.payload.session.state === state) return event.payload.session;
  }
}

test('a Session that reaches its cap waits on a blocking Ask, warned at half; Continue goes on and Stop stops it', async (t) => {
  const { kiln, events, ticket } = await setup(
    t,
    [{ do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.1, times: 4, intervalMs: 500 }, { do: 'wait_for_message' }],
    { perSession: { cost: 10 } },
  );
  const { session } = await start(kiln, ticket);
  await events.next('usage.recorded', { timeoutMs: 15_000 });

  const warned = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === ticket.id)!;
  assert.equal(warned.run?.usage?.cost, 5);
  assert.equal(warned.run?.usage?.unit, 'credits');
  assert.deepEqual(
    warned.run?.usage?.alerts.map((a) => [a.id, a.level, a.used, a.cap]),
    [['session-cost', 'warning', 5, 10]],
    'a warning at half the cap',
  );

  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.equal(reached.payload.scope, 'session');
  assert.equal(reached.payload.limit.id, 'session-cost');
  assert.deepEqual(reached.payload.paused, [session!.id]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${reached.payload.askId}`);
  assert.equal(ask.blocking, true);
  assert.equal(ask.itemId, ticket.id);
  assert.deepEqual(ask.options, ['Continue', 'Stop']);
  assert.deepEqual(ask.raisedBy, { kind: 'budget', budgetId: 'work' });
  const waiting = await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`);
  assert.equal(waiting.state, 'waiting', 'paused, not killed');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Continue' });
  const again = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.deepEqual([again.payload.limit.used, again.payload.limit.cap], [20, 20], 'Continue allowed one more cap');

  await kiln.api('POST', `/api/asks/${again.payload.askId}/answer`, { answer: 'Stop' });
  await sessionState(events, session!.id, 'stopped');
});

test('the Session turn cap counts its subagents', async (t) => {
  const { kiln, events, ticket } = await setup(
    t,
    [
      { do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      { do: 'usage', model: 'fake-small', inputTokens: 100, outputTokens: 50, costUsd: 0.01, subagent: { description: 'Look around' } },
      { do: 'wait_for_message' },
    ],
    { perSession: { turns: 2 } },
  );
  const { session } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.equal(reached.payload.limit.id, 'session-turns');
  assert.deepEqual([reached.payload.limit.used, reached.payload.limit.cap, reached.payload.limit.unit], [2, 2, 'turns']);
  assert.deepEqual(reached.payload.paused, [session!.id]);
});

const setClock = (kiln: TestKiln, now: string) => kiln.api<{ now: string }>('POST', '/api/test/clock', { now });

test('usage rolls up by Epic, Project, Stage, Item kind, and by day, week and month on the core clock', async (t) => {
  const turn = { do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.2 } as const;
  const { kiln, agent, events, project, epic, ticket } = await setup(t, [
    turn,
    { do: 'wait_for_message' },
    turn,
    { do: 'wait_for_message' },
    turn,
    { do: 'wait_for_message' },
  ]);
  // Local times: a Wednesday, the next Monday, then the first of the next month (a Wednesday).
  await setClock(kiln, '2026-03-04T10:00:00');
  const { session } = await start(kiln, ticket);
  await events.next('usage.recorded', { timeoutMs: 15_000 });
  for (const now of ['2026-03-09T10:00:00', '2026-04-01T10:00:00']) {
    await setClock(kiln, now);
    await agent.sendMessage(session!.id, { kind: 'text', text: 'go on' });
    await events.next('usage.recorded', { timeoutMs: 15_000 });
  }

  const by = async (group: string, query = '') =>
    (await kiln.api<UsageRollup[]>('GET', `/api/usage?by=${group}${query}`)).map((r) => [r.key, r.cost]);
  assert.deepEqual(await by('day'), [['2026-03-04', 10], ['2026-03-09', 10], ['2026-04-01', 10]]);
  assert.deepEqual(await by('week'), [['2026-03-02', 10], ['2026-03-09', 10], ['2026-03-30', 10]]);
  assert.deepEqual(await by('month'), [['2026-03', 20], ['2026-04', 10]]);
  assert.deepEqual(await by('epic'), [[epic.id, 30]]);
  assert.deepEqual(await by('project'), [[project.id, 30]]);
  assert.deepEqual(await by('stage'), [['implementing', 30]]);
  assert.deepEqual(await by('kind'), [['ticket', 30]]);
  assert.deepEqual(await by('day', '&from=2026-03-05&to=2026-03-31'), [['2026-03-09', 10]]);
  assert.deepEqual(await by('month', '&budget=other'), []);
});

/** The next event of a type that matches. */
async function nextWhere<E extends KilnEvent>(events: Awaited<ReturnType<TestKiln['events']>>, type: E['type'], match: (e: E) => boolean) {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs: 15_000 });
    if (match(event)) return event;
  }
}

test("a Project's daily cap pauses its work and holds new starts there until the next day", async (t) => {
  const { kiln, events, ticket, addTicket } = await setup(
    t,
    [{ do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.2 }, { do: 'wait_for_message' }],
    { perProjectPerDay: 10 },
  );
  await setClock(kiln, '2026-03-04T10:00:00');
  const { session } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.equal(reached.payload.scope, 'project');
  assert.equal(reached.payload.limit.id, 'project-day');
  assert.deepEqual(reached.payload.paused, [session!.id]);

  const other = await addTicket('Another');
  const held = await start(kiln, other);
  assert.equal(held.queued, true, 'held in Up next, though the pool has room');
  assert.match(held.entry!.held ?? '', /Daily limit/);

  await setClock(kiln, '2026-03-05T09:00:00');
  const started = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === other.id);
  assert.equal(started.payload.session.state, 'running');
  const first = await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`);
  assert.equal(first.state, 'waiting', 'the paused Session still waits for its Ask');
});

test('the monthly limit pauses only the work drawing from that Budget', async (t) => {
  const { kiln, agent, events, ticket, addTicket } = await setup(
    t,
    [{ do: 'usage', model: 'other-model', inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, { do: 'wait_for_message' }],
    { monthly: 10 },
  );
  await kiln.api('PUT', '/api/budgets/other', { kind: 'metered', name: 'Other', models: ['other-model'], unit: 'USD', ratePerUsd: 1 });
  const elsewhere = await addTicket('Elsewhere');
  const { session: onOther } = await start(kiln, elsewhere);
  await events.next('usage.recorded', { timeoutMs: 15_000 });

  agent.setScript([{ do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.2 }, { do: 'wait_for_message' }]);
  const { session: onWork } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.equal(reached.payload.scope, 'budget');
  assert.equal(reached.payload.limit.id, 'month');
  assert.deepEqual(reached.payload.paused, [onWork!.id]);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${onOther!.id}`)).state, 'running');

  const budgets = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.deepEqual(
    budgets.map((b) => [b.id, b.held, b.gauge.label]),
    [
      ['other', false, '0.01 of 10,000 USD this month'],
      ['work', true, '10 of 10 credits this month'],
    ],
  );
  const third = await addTicket('Third');
  const held = await start(kiln, third);
  assert.match(held.entry?.held ?? '', /Monthly limit/);
});

test("a Budget hold's Ask counts every Item and Session it paused in Needs you, not just the one that reached the cap", async (t) => {
  const { kiln, events, ticket, addTicket } = await setup(
    t,
    [{ do: 'usage', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.1 }, { do: 'wait_for_message' }],
    { monthly: 10 },
  );
  const first = await addTicket('First');
  const { session: one } = await start(kiln, first);
  await events.next('usage.recorded', { timeoutMs: 15_000 });
  const { session: two } = await start(kiln, ticket);
  const reached = await events.next<BudgetLimitReachedEvent>('budget.limit_reached', { timeoutMs: 15_000 });
  assert.deepEqual([...reached.payload.paused].sort(), [one!.id, two!.id].sort());

  const [ask] = (await kiln.api<Ask[]>('GET', '/api/asks')).filter((a) => a.raisedBy.kind === 'budget');
  assert.equal(ask!.blocks, 4, 'two Items and their two Sessions wait on it');
});

test('a Session whose model is in no Budget does not start: a Decision Ask names the model and the Budget setting, and it starts once the model has one', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  await kiln.api('PUT', '/api/budgets/other', { kind: 'metered', name: 'Other', models: ['other-model'] });
  const { ticket } = await seedProject(kiln);
  const events = await kiln.events();

  const held = await start(kiln, ticket);

  assert.equal(held.queued, true, 'held in Up next');
  assert.match(held.entry!.held ?? '', /fake-model/);
  const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 });
  const ask = raised.payload.ask;
  assert.equal(ask.type, 'decision');
  assert.equal(ask.itemId, ticket.id);
  assert.match(ask.question, /"fake-model"/);
  assert.match(ask.why, /Budget/);
  assert.match(ask.why, /\/api\/budgets/);

  await kiln.api('PUT', '/api/budgets/other', { kind: 'metered', name: 'Other', models: ['other-model', 'fake-model'] });
  const started = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === ticket.id);
  assert.equal(started.payload.session.state, 'running');
  assert.equal(started.payload.session.model, 'fake-model');
  const open = await kiln.api<Ask[]>('GET', `/api/asks?item=${encodeURIComponent(ticket.id)}`);
  assert.deepEqual(open, [], 'the Ask is settled once the model has a Budget');
});

test('a Session with no model at all (the Stage names none, nor does its Agent) does not start, and a Decision Ask says where to set one', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }], model: null });
  const { ticket } = await seedProject(kiln);
  const events = await kiln.events();

  const held = await start(kiln, ticket);

  assert.equal(held.queued, true, 'held in Up next, not run on the Agent tool\'s own default');
  assert.match(held.entry!.held ?? '', /no model/);
  const ask = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 })).payload.ask;
  assert.equal(ask.type, 'decision');
  assert.equal(ask.itemId, ticket.id);
  assert.match(ask.question, /no model/);
  assert.match(ask.why, /workflow\.json/);
});

test("a Stage's model goes to the Agent that draws from its Budget, not to whichever Agent is ready first", async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const widgetRepo = createFakeWidgetRepo(t);
  const ready = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: widgetRepo.path, path: 'widgets/claude-code' });
  await kiln.api('POST', '/api/widgets/claude-code/approve');
  await ready.next('widget.ready', { timeoutMs: 20_000 });
  await kiln.api('PUT', '/api/budgets/work', { kind: 'metered', name: 'Work', models: ['fake-model', 'fake-small'] });
  await kiln.api('PUT', '/api/budgets/max', { kind: 'subscription', name: 'Max', models: ['claude-test-model', 'claude-other'] });
  const { ticket, addTicket } = await seedProject(kiln);
  const other = await addTicket('Another');

  await kiln.api('PUT', '/api/setup', { roles: { implementer: { model: 'claude-other' } } });
  const onMax = await start(kiln, ticket);
  await kiln.api('PUT', '/api/setup', { roles: { implementer: { model: 'fake-small' } } });
  const onWork = await start(kiln, other);

  assert.deepEqual([onMax.session?.agentId, onMax.session?.model], ['claude', 'claude-other']);
  assert.deepEqual([onWork.session?.agentId, onWork.session?.model], ['fake', 'fake-small']);
});

test('a model draws from one Budget, and Budget settings are checked', async (t) => {
  const kiln = await startTestKiln(t);
  const work = await kiln.api<BudgetInfo>('PUT', '/api/budgets/work', { kind: 'metered', name: 'Work', models: ['fake-model'] });
  assert.deepEqual(work.config, { unit: 'credits', ratePerUsd: 50, monthly: 10_000, perSession: { cost: 500, turns: 150 }, perProjectPerDay: 1_250 });
  assert.equal(work.gauge.label, '0 of 10,000 credits this month');

  const clash = await kiln.request('PUT', '/api/budgets/other', { kind: 'metered', models: ['fake-model'] });
  assert.equal(clash.status, 409);
  assert.equal((await kiln.request('PUT', '/api/budgets/other', { kind: 'metered', models: [] })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/budgets/other', { kind: 'metered', models: ['m'], monthly: -1 })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/budgets/other', { kind: 'barter', models: ['m'] })).status, 400);
});

test('only a test instance has a clock to move', async (t) => {
  const kiln = await startTestKiln(t);
  const moved = await kiln.api<{ now: string }>('POST', '/api/test/clock', { now: '2030-01-01T00:00:00Z' });
  assert.equal(moved.now, '2030-01-01T00:00:00.000Z');

  const started = await cli(['dev', '--worktree', REPO_ROOT, '--json']);
  assert.equal(started.code, 0, started.stderr);
  const dev = JSON.parse(started.stdout) as { url: string; dataDir: string };
  t.after(() => cli(['stop', '--data-dir', dev.dataDir]));
  const live = await fetch(`${dev.url}/api/test/clock`, { method: 'GET' });
  assert.equal(live.status, 404);
});
