// The subscription Budget (ticket 17): a flat plan measured in plan usage. Agents report quota
// readings per window; Kiln stores them, attributes each Session's share of the change, and
// enforces the per-Session share, the pace rule, the reserves and paid overage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  BudgetInfo,
  BudgetLimitReachedEvent,
  SessionInfo,
  Item,
  KilnEvent,
  Project,
  QuotaHoldEvent,
  QuotaReadingRecord,
  QuotaReleasedEvent,
  QuotaRollup,
  SessionStartedEvent,
  StartResult,
} from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

type Events = Awaited<ReturnType<TestKiln['events']>>;

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

async function setup(t: Parameters<typeof startTestKiln>[0], script: FakeAgentScript, budget: Record<string, unknown> = {}) {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script });
  await kiln.api<BudgetInfo>('PUT', '/api/budgets/home', { kind: 'subscription', name: 'Home', models: ['fake-model', 'fake-fable'], ...budget });
  const seeded = await seedProject(kiln);
  const events = await kiln.events();
  return { kiln, agent, events, ...seeded };
}

/** The next event of a type that matches. */
async function nextWhere<E extends KilnEvent>(events: Events, type: E['type'], match: (e: E) => boolean = () => true) {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs: 15_000 });
    if (match(event)) return event;
  }
}

const turn = (tokens: number, model = 'fake-model') => ({ do: 'usage', model, inputTokens: tokens, outputTokens: 0 }) as const;
const week = (percent: number, resetsAt = '2026-11-09T09:00:00.000Z') => ({ do: 'quota', reading: { window: 'week', percent, resetsAt } }) as const;

test("quota readings are stored, and a change is split across concurrent Sessions in proportion to their tokens", async (t) => {
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [week(10), turn(3_000), { do: 'wait_for_message' }, week(16), { do: 'wait_for_message' }]);
  const { session: a } = await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  await nextWhere(events, 'usage.recorded');

  agent.setScript([turn(1_000), { do: 'wait_for_message' }]);
  const other = await addTicket('Another');
  const { session: b } = await start(kiln, other);
  await nextWhere(events, 'usage.recorded');

  await agent.sendMessage(a!.id, { kind: 'text', text: 'finish up' });
  await nextWhere(events, 'quota.recorded');

  const readings = await kiln.api<QuotaReadingRecord[]>('GET', '/api/quota/readings?budget=home');
  assert.deepEqual(
    readings.map((r) => [r.window, r.percent, r.sessionId, r.budgetId]),
    [['week', 10, a!.id, 'home'], ['week', 16, a!.id, 'home']],
  );
  assert.equal(readings[0]!.resetsAt, '2026-11-09T09:00:00.000Z');
  assert.equal(readings[0]!.source, 'fake');

  const bySession = await kiln.api<QuotaRollup[]>('GET', '/api/usage/quota?budget=home&window=week&by=session');
  assert.deepEqual(
    bySession.map((r) => [r.key, r.percent, r.approximate]),
    [[a!.id, 4.5], [b!.id, 1.5]].map(([key, percent]) => [key, percent, true]),
    'the 6-point change split 3:1 by tokens, labelled approximate',
  );
});

test('resets_at jitter of milliseconds is not a reset: 89 to 90 attributes 1, not 90', async (t) => {
  const { kiln, events, ticket } = await setup(t, [
    week(89, '2026-11-09T09:00:00.293Z'), turn(1_000), week(90, '2026-11-09T09:00:00.957Z'), { do: 'wait_for_message' },
  ]);
  await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  await nextWhere(events, 'quota.recorded');
  const rollup = await kiln.api<QuotaRollup[]>('GET', '/api/usage/quota?budget=home&window=week&by=session');
  assert.deepEqual(rollup.map((r) => r.percent), [1]);
});

test('resets_at moving by days is a real reset: the new reading is all new use', async (t) => {
  const { kiln, events, ticket } = await setup(t, [
    week(89, '2026-11-09T09:00:00.000Z'), turn(1_000), week(3, '2026-11-16T09:00:00.000Z'), { do: 'wait_for_message' },
  ]);
  await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  await nextWhere(events, 'quota.recorded');
  const rollup = await kiln.api<QuotaRollup[]>('GET', '/api/usage/quota?budget=home&window=week&by=session');
  assert.deepEqual(rollup.map((r) => r.percent), [3]);
});

const setClock = (kiln: TestKiln, now: string) => kiln.api<{ now: string }>('POST', '/api/test/clock', { now });

test('ahead of pace, new unattended Sessions hold behind a blocking Ask while running ones carry on', async (t) => {
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [week(45), { do: 'wait_for_message' }, { do: 'wait_for_message' }]);
  // The week runs from Mon 2 Nov 09:00 UTC; on Wed 4 Nov 09:00 it is 28.6% through, so 45% is 16 points ahead.
  await setClock(kiln, '2026-11-04T09:00:00.000Z');
  const { session: running } = await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');

  const home = (await kiln.api<BudgetInfo[]>('GET', '/api/budgets')).find((b) => b.id === 'home')!;
  const weekly = home.windows!.find((w) => w.id === 'week')!;
  assert.deepEqual([weekly.percent, Math.round(weekly.pace!), weekly.aheadOfPace], [45, 29, true]);

  const other = await addTicket('Another');
  const held = await start(kiln, other);
  assert.equal(held.queued, true, 'held in Up next, though the pool has room');
  assert.match(held.entry!.held ?? '', /ahead of pace/);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.equal(hold.payload.rule, 'pace');
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.equal(ask.type, 'decision');
  assert.equal(ask.blocking, true);
  assert.equal(ask.recommendation, 'Hold until back on pace');
  assert.deepEqual(ask.options, ['Hold until back on pace', 'Start anyway']);

  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${running!.id}`)).state, 'running', 'running Sessions continue');
  await agent.sendMessage(running!.id, { kind: 'text', text: 'keep going' });
  await nextWhere<KilnEvent<string, { text?: string }>>(events, 'session.progress', (e) => e.payload.text === 'heard: keep going');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Hold until back on pace' });
  // By Fri 6 Nov 09:00 the week is 57% through: back on pace, so the held Session starts.
  await setClock(kiln, '2026-11-06T09:00:00.000Z');
  const started = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === other.id);
  assert.equal(started.payload.session.state, 'running');
});

test('"Start anyway" lets unattended Sessions start while ahead of pace', async (t) => {
  const { kiln, events, ticket, addTicket } = await setup(t, [week(45), { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-04T09:00:00.000Z');
  await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  const other = await addTicket('Another');
  assert.equal((await start(kiln, other)).queued, true);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  await kiln.api('POST', `/api/asks/${hold.payload.askIds[0]}/answer`, { answer: 'Start anyway' });
  await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === other.id);
});

test('ahead of pace, a Thread message still starts its Session: the pace rule holds only unattended starts', async (t) => {
  const { kiln, events, ticket, addTicket } = await setup(t, [week(45), { do: 'wait_for_message' }, { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-04T09:00:00.000Z');
  await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  const other = await addTicket('Another');

  const sent = await kiln.api<{ delivery: string; sessionId?: string }>('POST', `/api/items/${encodeURIComponent(other.id)}/messages`, { text: 'look at this' });

  assert.equal(sent.delivery, 'fresh', 'a person in the Thread is attending: no pace hold');
  const started = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === other.id);
  assert.equal(started.payload.session.id, sent.sessionId);
});

const sessionState = async (kiln: TestKiln, id: string) => (await kiln.api<SessionInfo>('GET', `/api/sessions/${id}`)).state;

test('at the 5-hour reserve the Budget\'s work pauses behind a non-blocking Ask and resumes by itself after the reset', async (t) => {
  const fiveHour = { do: 'quota', reading: { window: 'five_hour', percent: 92, resetsAt: '2026-11-02T14:00:00.000Z' } } as const;
  const { kiln, events, ticket } = await setup(t, [fiveHour, { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-02T10:00:00.000Z');
  const { session } = await start(kiln, ticket);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.deepEqual([hold.payload.rule, hold.payload.window, hold.payload.paused], ['reserve', '5h', [session!.id]]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.equal(ask.blocking, false);
  assert.deepEqual([ask.options, ask.recommendation], [['Wait', 'Stop'], 'Wait']);
  assert.equal(await sessionState(kiln, session!.id), 'waiting');

  await setClock(kiln, '2026-11-02T14:01:00.000Z');
  const released = await nextWhere<QuotaReleasedEvent>(events, 'quota.released');
  assert.deepEqual(released.payload.released, [session!.id]);
  assert.equal(await sessionState(kiln, session!.id), 'running');
  const fiveHourNow = (await kiln.api<BudgetInfo[]>('GET', '/api/budgets'))[0]!.windows!.find((w) => w.id === '5h')!;
  assert.equal(fiveHourNow.known, false, 'past its reset the window is unknown until the next reading');
});

test('at the weekly reserve all the Budget\'s work pauses behind a blocking Ask; Continue lets it run into the reserve', async (t) => {
  // Both Sessions wait for a message; only the first is sent one, and reports the week at 91%.
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [{ do: 'wait_for_message' }, week(91), { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-08T09:00:00.000Z');
  const { session: a } = await start(kiln, ticket);
  const other = await addTicket('Another');
  const { session: b } = await start(kiln, other);
  await agent.sendMessage(a!.id, { kind: 'text', text: 'go on' });
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold', (e) => e.payload.rule === 'reserve');
  assert.equal(hold.payload.window, 'week');
  assert.deepEqual([...hold.payload.paused].sort(), [a!.id, b!.id].sort());
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.deepEqual([ask.blocking, ask.options], [true, ['Continue', 'Stop']]);
  assert.equal(await sessionState(kiln, b!.id), 'waiting');
  const third = await addTicket('Third');
  assert.match((await start(kiln, third)).entry?.held ?? '', /reserve/, 'new starts hold too');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Continue' });
  await nextWhere<QuotaReleasedEvent>(events, 'quota.released');
  assert.deepEqual([await sessionState(kiln, a!.id), await sessionState(kiln, b!.id)], ['running', 'running']);
});

test('at the Fable reserve its Sessions pause behind an Ask per Stage offering the fallback model, which restarts them on it', async (t) => {
  const fable = { do: 'quota', reading: { window: 'seven_day_model', model: 'Fable', percent: 93, resetsAt: '2026-11-09T09:00:00.000Z' } } as const;
  const { kiln, agent, events, ticket } = await setup(t, [fable, { do: 'wait_for_message' }], {
    models: ['fake-model', 'fake-sonnet'],
    fableModels: ['fake-model'],
  });
  await setClock(kiln, '2026-11-06T09:00:00.000Z');
  const { session } = await start(kiln, ticket);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.deepEqual([hold.payload.rule, hold.payload.window, hold.payload.paused], ['reserve', 'fable', [session!.id]]);
  assert.equal(hold.payload.askIds.length, 1, 'one Ask for the one Stage');
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.deepEqual([ask.blocking, ask.options, ask.recommendation], [true, ['Use fake-sonnet', 'Wait for the reset', 'Stop'], 'Use fake-sonnet']);
  assert.equal(await sessionState(kiln, session!.id), 'waiting');

  agent.setScript([{ do: 'wait_for_message' }]);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Use fake-sonnet' });
  const restarted = await nextWhere<SessionStartedEvent>(events, 'session.started', (e) => e.payload.itemId === ticket.id && e.payload.session.id !== session!.id);
  assert.equal(restarted.payload.session.model, 'fake-sonnet');
  assert.notEqual(await sessionState(kiln, session!.id), 'running');
});

test('paid overage pauses the Budget\'s work behind a blocking Ask, whether reported or seen as rising credits', async (t) => {
  const credits = (usedCredits: number) => ({ do: 'quota', reading: { window: 'week', percent: 50, resetsAt: '2026-11-09T09:00:00.000Z', usedCredits } }) as const;
  const { kiln, agent, events, ticket, addTicket } = await setup(t, [credits(10), { do: 'wait_for_message' }, credits(12), { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-06T09:00:00.000Z');
  const { session } = await start(kiln, ticket);
  await nextWhere(events, 'quota.recorded');
  assert.equal(await sessionState(kiln, session!.id), 'running', 'credits alone are not overage');
  await agent.sendMessage(session!.id, { kind: 'text', text: 'next' });
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.deepEqual([hold.payload.rule, hold.payload.paused], ['overage', [session!.id]]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.deepEqual([ask.blocking, ask.options], [true, ['Continue', 'Stop']]);
  assert.equal(await sessionState(kiln, session!.id), 'waiting');

  agent.setScript([{ do: 'quota', reading: { window: 'week', percent: 50, resetsAt: '2026-11-09T09:00:00.000Z', usingOverage: true } }, { do: 'wait_for_message' }]);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Stop' });
  const other = await addTicket('Another');
  const { session: next } = await start(kiln, other);
  const reported = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.deepEqual([reported.payload.rule, reported.payload.paused], ['overage', [next!.id]], 'reported overage pauses too');
});

test('a window with no current reading shows unknown and its rules are off, while the others work', async (t) => {
  const fiveHour = { do: 'quota', reading: { window: '5h', percent: null, resetsAt: null } } as const;
  const { kiln, events, ticket } = await setup(t, [fiveHour, week(95), { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-08T23:00:00.000Z');
  await start(kiln, ticket);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold');
  assert.deepEqual([hold.payload.rule, hold.payload.window], ['reserve', 'week'], 'the week, which is known, still holds');
  const windows = (await kiln.api<BudgetInfo[]>('GET', '/api/budgets'))[0]!.windows!;
  assert.deepEqual(
    windows.map((w) => [w.id, w.known, w.label]),
    [
      ['week', true, 'Week: 95% used, pace 94%, resets in 10h 0m'],
      ['5h', false, '5-hour window: unknown'],
      ['fable', false, 'Fable: unknown'],
    ],
  );
});

test("a Session's share of the week pauses it at the per-Session cap and raises a blocking Ask", async (t) => {
  const { kiln, events, ticket } = await setup(t, [week(10), turn(1_000), week(12), turn(1_000), week(14), { do: 'wait_for_message' }], {
    perSession: { share: 4 },
  });
  const { session } = await start(kiln, ticket);
  const reached = await nextWhere<BudgetLimitReachedEvent>(events, 'budget.limit_reached');
  assert.equal(reached.payload.limit.id, 'session-share');
  assert.deepEqual([reached.payload.limit.used, reached.payload.limit.cap], [4, 4]);
  assert.match(reached.payload.limit.unit, /% of week/);
  assert.deepEqual(reached.payload.paused, [session!.id]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${reached.payload.askId}`);
  assert.equal(ask.blocking, true);
  assert.deepEqual(ask.options, ['Continue', 'Stop']);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`)).state, 'waiting');
});

// The runaway guard: Kiln's attributed share of the week over a rolling window.
const T0 = Date.parse('2026-11-08T09:00:00.000Z');
const wk = (percent: number, minutes = 0, resetsAt = '2026-11-09T09:00:00.000Z') =>
  ({ do: 'quota', reading: { window: 'week', percent, resetsAt, takenAt: new Date(T0 + minutes * 60_000).toISOString() } }) as const;
const guardSetup = (t: Parameters<typeof startTestKiln>[0], script: FakeAgentScript) =>
  setup(t, script, { perSession: { share: 100, turns: 150 } }).then(async (s) => {
    await setClock(s.kiln, '2026-11-08T09:30:00.000Z');
    return s;
  });
const guardAsks = async (kiln: TestKiln) => (await kiln.api<Ask[]>('GET', '/api/asks')).filter((a) => a.raisedBy.kind === 'budget' && /Kiln used/.test(a.question));
const settle = async (events: Events, n: number) => {
  for (let i = 0; i < n; i++) await nextWhere(events, 'quota.recorded');
};

test('a small Session never trips the guard however high the week total is, whatever resets_at jitters by', async (t) => {
  const jitter = (percent: number, ms: number) => wk(percent, 0, new Date(Date.parse('2026-11-09T09:00:00.000Z') + ms).toISOString());
  const { kiln, events, ticket } = await setup(t, [jitter(89, 293), turn(1_000), jitter(90, 957), { do: 'wait_for_message' }], { perSession: { share: 100, turns: 150 } });
  await setClock(kiln, '2026-11-08T09:30:00.000Z');
  const { session } = await start(kiln, ticket);
  await settle(events, 2);
  assert.deepEqual(await guardAsks(kiln), []);
  assert.equal(await sessionState(kiln, session!.id), 'waiting', 'not paused by the guard');
  const rollup = await kiln.api<QuotaRollup[]>('GET', '/api/usage/quota?budget=home&window=week&by=session');
  assert.deepEqual(rollup.map((r) => r.percent), [1]);
});

test("the person's own use outside Kiln never trips the guard", async (t) => {
  const { kiln, events, ticket } = await guardSetup(t, [wk(10), wk(60, 5), { do: 'wait_for_message' }]);
  await start(kiln, ticket);
  await settle(events, 2);
  assert.deepEqual(await guardAsks(kiln), []);
});

test('Kiln use over the guard pauses running Sessions, holds new starts and raises one Ask; Continue lifts the mark by another 20%', async (t) => {
  const { kiln, agent, events, ticket, addTicket } = await guardSetup(t, [
    wk(10), turn(1_000), wk(35, 5), wk(36, 6), { do: 'wait_for_message' },
    turn(1_000), wk(50, 10), { do: 'wait_for_message' },
    turn(1_000), wk(70, 15), { do: 'wait_for_message' },
  ]);
  const { session } = await start(kiln, ticket);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold', (e) => e.payload.rule === 'guard');
  assert.deepEqual(hold.payload.paused, [session!.id]);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${hold.payload.askIds[0]}`);
  assert.deepEqual([ask.blocking, ask.options], [true, ['Continue for another 20%', 'Stop']]);
  assert.match((await start(kiln, await addTicket('Another'))).entry?.held ?? '', /guard/);
  assert.equal((await guardAsks(kiln)).length, 1, 'one Ask however many readings follow');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Continue for another 20%' });
  await nextWhere<QuotaReleasedEvent>(events, 'quota.released', (e) => e.payload.rule === 'guard');
  await agent.sendMessage(session!.id, { kind: 'text', text: 'go on' });
  await settle(events, 3);
  assert.equal((await guardAsks(kiln)).filter((a) => a.state === 'open').length, 0, '40 of 45: under the new mark');
  await agent.sendMessage(session!.id, { kind: 'text', text: 'more' });
  await nextWhere<QuotaHoldEvent>(events, 'quota.hold', (e) => e.payload.rule === 'guard');
  assert.equal((await guardAsks(kiln)).filter((a) => a.state === 'open').length, 1, 'a new single Ask over the new mark');
});

test('Stop ends the paused Sessions; new starts stay held, with no new Ask, until the total rolls off', async (t) => {
  const { kiln, events, ticket, addTicket } = await guardSetup(t, [wk(10), turn(1_000), wk(35, 5), { do: 'wait_for_message' }]);
  const { session } = await start(kiln, ticket);
  const hold = await nextWhere<QuotaHoldEvent>(events, 'quota.hold', (e) => e.payload.rule === 'guard');
  await kiln.api('POST', `/api/asks/${hold.payload.askIds[0]}/answer`, { answer: 'Stop' });
  await nextWhere(events, 'session.updated', (e: KilnEvent) => (e.payload as { session: { id: string; state: string } }).session.id === session!.id && (e.payload as { session: { state: string } }).session.state === 'stopped');
  const next = await addTicket('Next');
  assert.match((await start(kiln, next)).entry?.held ?? '', /guard/);
  assert.equal((await guardAsks(kiln)).filter((a) => a.state === 'open').length, 0, 'no new Ask');

  await setClock(kiln, '2026-11-08T22:00:00.000Z');
  assert.equal((await start(kiln, await addTicket('Later'))).entry?.held ?? undefined, undefined, 'the 25 points rolled off the 12 hours');
});

test('the same use spread over more than 12 hours does not trip the guard', async (t) => {
  const { kiln, events, ticket } = await guardSetup(t, [wk(10), turn(1_000), wk(25, 5), turn(1_000), wk(40, 13 * 60), { do: 'wait_for_message' }]);
  await setClock(kiln, '2026-11-08T23:00:00.000Z');
  await start(kiln, ticket);
  await settle(events, 3);
  assert.deepEqual(await guardAsks(kiln), []);
});
