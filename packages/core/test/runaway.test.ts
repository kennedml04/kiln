// Runaway guards that apply to every Budget kind (ticket 16): the stall rule and the context alarm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  ContextAlarmEvent,
  Item,
  KilnEvent,
  Project,
  RunawaySettings,
  SessionInfo,
  SessionStalledEvent,
  SessionUpdatedEvent,
  StartResult,
} from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

type Events = Awaited<ReturnType<TestKiln['events']>>;

/** Registers the seeded Project, installs the fake Agent and returns the ready Ticket ("Draw the columns"). */
async function setup(t: Parameters<typeof startTestKiln>[0], script: FakeAgentScript, settings?: Partial<RunawaySettings>) {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script });
  if (settings) await kiln.api('PUT', '/api/runaway', settings);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  return { kiln, agent, events, project, ticket };
}

const start = async (kiln: TestKiln, item: Item) =>
  (await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`)).session!;

async function nextWhere<E extends KilnEvent>(events: Events, type: string, match: (e: E) => boolean) {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs: 20_000 });
    if (match(event)) return event;
  }
}

const sessionState = (events: Events, id: string, state: string) =>
  nextWhere<SessionUpdatedEvent>(events, 'session.updated', (e) => e.payload.session.id === id && e.payload.session.state === state);

const answer = (kiln: TestKiln, askId: string, text: string) => kiln.api<Ask>('POST', `/api/asks/${askId}/answer`, { answer: text });

test('the stall and context-alarm thresholds default to the spec, and only an Admin can change them', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  const defaults = await kiln.api<RunawaySettings>('GET', '/api/runaway');
  assert.deepEqual(defaults, { stallTurns: 8, repeatedToolCalls: 3, contextTokens: 300_000, contextShare: 0.6 });

  const refused = await kiln.as('mo').request('PUT', '/api/runaway', { stallTurns: 20 });
  assert.equal(refused.status, 403);

  const bad = await kiln.request('PUT', '/api/runaway', { contextShare: 1.5 });
  assert.equal(bad.status, 400);

  const changed = await kiln.api<RunawaySettings>('PUT', '/api/runaway', { stallTurns: 5, contextTokens: 200_000 });
  assert.deepEqual(changed, { stallTurns: 5, repeatedToolCalls: 3, contextTokens: 200_000, contextShare: 0.6 });
  assert.deepEqual(await kiln.as('mo').api<RunawaySettings>('GET', '/api/runaway'), changed);
});

test('the same tool call with the same arguments 3 times in a row pauses the Session on a blocking Ask; Continue goes on, Stop stops it', async (t) => {
  const { kiln, events, ticket } = await setup(t, [
    { do: 'tool', name: 'bash', input: { command: 'ls' }, times: 2 },
    { do: 'tool', name: 'bash', input: { command: 'npm test' }, times: 'forever', intervalMs: 20 },
  ]);
  const session = await start(kiln, ticket);

  const stalled = await nextWhere<SessionStalledEvent>(events, 'session.stalled', (e) => e.payload.sessionId === session.id);
  assert.equal(stalled.payload.rule, 'tool');
  assert.match(stalled.payload.detail, /npm test/);
  const ask = await kiln.api<Ask>('GET', `/api/asks/${stalled.payload.askId}`);
  assert.equal(ask.blocking, true);
  assert.equal(ask.itemId, ticket.id);
  assert.deepEqual(ask.options, ['Continue', 'Stop']);
  const paused = await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`);
  assert.equal(paused.state, 'waiting', 'paused, not killed');

  await answer(kiln, ask.id, 'Continue');
  await sessionState(events, session.id, 'running');
  const again = await nextWhere<SessionStalledEvent>(events, 'session.stalled', (e) => e.payload.sessionId === session.id);
  assert.notEqual(again.payload.askId, ask.id, 'the count starts over after Continue');

  await answer(kiln, again.payload.askId, 'Stop');
  await sessionState(events, session.id, 'stopped');
});

test('8 turns in a row with no new commit and no artifact change pause the Session on a blocking Ask; a commit or an artifact edit starts the count over', async (t) => {
  const turn = { do: 'usage', inputTokens: 100, outputTokens: 10 } as const;
  const { kiln, events, ticket } = await setup(t, [
    { ...turn, times: 3 },
    { do: 'write', path: 'src/columns.ts', content: 'export const columns = 3;\n' },
    { do: 'commit', message: 'Draw the columns' },
    { ...turn, times: 5 },
    { do: 'write', path: '.scratch/home-board/issues/01-draw-the-columns.md', content: '# Draw the columns\n\nNotes from the Session.\n' },
    { ...turn, times: 30, intervalMs: 30 },
  ]);
  const session = await start(kiln, ticket);

  const stalled = await nextWhere<SessionStalledEvent>(events, 'session.stalled', (e) => e.payload.sessionId === session.id);
  // The Item's Thread shows the stall in order among the turns.
  const thread = await kiln.api<KilnEvent[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`);
  const at = thread.findIndex((e) => e.type === 'session.stalled');
  assert.ok(at > 0, 'the stall is in the Thread');
  const turns = thread.slice(0, at).filter((e) => e.type === 'session.usage').length;

  assert.equal(stalled.payload.rule, 'turns');
  assert.match(stalled.payload.detail, /8 turns/);
  // Turns 1-3 made nothing; turn 4 made the commit and turn 9 the artifact edit; turns 10-17 made nothing.
  assert.equal(turns, 17, 'the commit and the artifact edit each started the count over');
  const ask = await kiln.api<Ask>('GET', `/api/asks/${stalled.payload.askId}`);
  assert.equal(ask.blocking, true);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'waiting');
});

/**
 * Starts a Session that waits for a Thread message, then reports `turns`; the fresh Session after it
 * reports what it was seeded with. Returns the context_alarm and the fresh Session's seed.
 */
async function alarmRun(t: Parameters<typeof startTestKiln>[0], turns: FakeAgentScript, settings?: Partial<RunawaySettings>) {
  const { kiln, agent, events, ticket } = await setup(
    t,
    [{ do: 'progress', text: 'first' }, { do: 'wait_for_message' }, ...turns, { do: 'wait_for_message' }],
    settings,
  );
  const first = await start(kiln, ticket);
  // Once the first Session has read its script, the fresh one gets this one.
  await nextWhere<KilnEvent<'session.progress', { sessionId: string; text?: string }>>(events, 'session.progress', (e) => e.payload.text === 'first');
  agent.setScript([{ do: 'report_seed' }, { do: 'wait_for_message' }]);
  await kiln.api('POST', `/api/items/${encodeURIComponent(ticket.id)}/messages`, { text: 'go on' });
  const alarm = await nextWhere<ContextAlarmEvent>(events, 'session.context_alarm', (e) => e.payload.sessionId === first.id);
  const fresh = await nextWhere<KilnEvent<'session.started', { sessionId: string; itemId: string }>>(events, 'session.started', (e) => e.payload.itemId === ticket.id && e.payload.sessionId !== first.id);
  const seen = await nextWhere<KilnEvent<'session.progress', { sessionId: string; text?: string }>>(
    events,
    'session.progress',
    (e) => e.payload.sessionId === fresh.payload.sessionId && /^seed: /.test(e.payload.text ?? ''),
  );
  const seed = JSON.parse(seen.payload.text!.slice('seed: '.length)) as { seed: { digests?: string[] } };
  return { kiln, ticket, first, alarm, fresh, seed };
}

test('passing 60% of the context window ends the Session with a Digest and goes on in a fresh Session seeded from it, without an Ask', async (t) => {
  const turn = { do: 'usage', inputTokens: 100, outputTokens: 10, contextWindow: 200_000 } as const;
  const { kiln, ticket, first, alarm, fresh, seed } = await alarmRun(t, [
    { ...turn, contextTokens: 110_000 },
    { ...turn, contextTokens: 130_000 },
  ]);

  assert.equal(alarm.payload.threshold, 120_000, 'the lower of 300k and 60% of 200k');
  assert.equal(alarm.payload.contextTokens, 130_000);
  assert.notEqual(fresh.payload.sessionId, first.id);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${first.id}`)).state, 'stopped');
  assert.ok(seed.seed.digests?.some((d) => /context/i.test(d)), 'the fresh Session is seeded with the Digest left at the alarm');
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), [], 'no Ask');
  const thread = await kiln.api<KilnEvent[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`);
  assert.ok(thread.some((e) => e.type === 'digest.written' && (e.payload as { sessionId?: string }).sessionId === first.id));
});

test('without a reported context window the alarm fires past 300k tokens, or the threshold an Admin set', async (t) => {
  const turn = { do: 'usage', inputTokens: 100, outputTokens: 10 } as const;
  const { alarm } = await alarmRun(t, [{ ...turn, contextTokens: 290_000 }, { ...turn, contextTokens: 310_000 }]);
  assert.equal(alarm.payload.threshold, 300_000);

  const lowered = await alarmRun(t, [{ ...turn, contextTokens: 60_000 }], { contextTokens: 50_000 });
  assert.equal(lowered.alarm.payload.threshold, 50_000);
});

test('an Agent that keeps saying it is done without meeting the Exit stalls instead of running forever', async (t) => {
  const { kiln, events, ticket } = await setup(t, Array.from({ length: 12 }, () => ({ do: 'finish' }) as const), { stallTurns: 3 });
  const session = await start(kiln, ticket);

  const stalled = await nextWhere<SessionStalledEvent>(events, 'session.stalled', (e) => e.payload.sessionId === session.id);

  assert.equal(stalled.payload.rule, 'turns');
  const thread = await kiln.api<KilnEvent[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`);
  const checks = thread.filter((e) => e.type === 'exit.checked');
  assert.equal(checks.length, 3, 'each unmet Exit check with no turn reported counts as a turn');
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'waiting');
});
