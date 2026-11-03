import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, AuditEntry, Item, Project, SessionAgentEvent, SessionInfo, SessionUpdatedEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}"`);
  return item;
};

async function seededTicket(kiln: TestKiln): Promise<{ project: Project; ticket: Item; items: Item[] }> {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  return { project, ticket: byTitle(items, 'Draw the columns'), items };
}

async function start(kiln: TestKiln, item: Item): Promise<SessionInfo> {
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);
  assert.ok(session, 'the Session starts at once');
  return session;
}

type Progress = SessionAgentEvent<'progress'>;

const DECISION = {
  type: 'decision',
  question: 'Store the columns in SQLite or in the Tracker?',
  why: 'The board layout depends on it.',
  recommendation: 'SQLite',
  options: ['SQLite', 'Tracker'],
  blocking: true,
};

/** Waits for the next progress event whose text matches. */
async function progress(events: Awaited<ReturnType<TestKiln['events']>>, pattern: RegExp): Promise<Progress> {
  for (;;) {
    const event = await events.next<Progress>('session.progress', { timeoutMs: 15_000 });
    if (pattern.test(event.payload.text ?? '')) return event;
  }
}

test('each Session gets the Kiln tools over MCP, and the endpoint refuses callers without a Session credential', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'kiln_tools_list' }, { do: 'wait_for_message' }] });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();

  await start(kiln, ticket);
  const listed = await events.next<Progress>('session.progress', { timeoutMs: 15_000 });
  assert.equal(listed.payload.text, 'tools: raise_ask, read_item, read_artifacts, write_digest');

  const anonymous = await kiln.request('POST', '/api/kiln-tools', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(anonymous.status, 401);
  const forged = await kiln.request(
    'POST',
    '/api/kiln-tools',
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { authorization: 'Bearer not-a-session' },
  );
  assert.equal(forged.status, 401);
});

test('a blocking Ask pauses the Session, lands in Needs you, and answering resumes the Session with the answer', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'ask', ask: DECISION }, { do: 'progress', text: 'after the Ask' }] });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 });
  const ask = raised.payload.ask;
  assert.deepEqual(
    {
      type: ask.type,
      itemId: ask.itemId,
      question: ask.question,
      why: ask.why,
      recommendation: ask.recommendation,
      options: ask.options,
      blocking: ask.blocking,
      state: ask.state,
      raisedBy: ask.raisedBy,
    },
    {
      type: 'decision',
      itemId: ticket.id,
      question: DECISION.question,
      why: DECISION.why,
      recommendation: 'SQLite',
      options: ['SQLite', 'Tracker'],
      blocking: true,
      state: 'open',
      raisedBy: { kind: 'session', sessionId: session.id },
    },
  );
  await progress(events, /^ask raised: /);
  const paused = await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`);
  assert.equal(paused.state, 'waiting');
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns').runState, 'waiting');
  assert.deepEqual((await kiln.api<Ask[]>('GET', '/api/asks')).map((a) => a.id), [ask.id]);

  const answered = await kiln.api<Ask>('POST', `/api/asks/${ask.id}/answer`, { answer: 'Tracker' });
  assert.equal(answered.state, 'answered');
  assert.equal(answered.answer, 'Tracker');
  assert.deepEqual(answered.answeredBy, { kind: 'user', id: 'local' });
  await progress(events, /^answered: Tracker$/);
  await progress(events, /^after the Ask$/);
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), []);
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=ask.answer');
  assert.equal(audit[0]?.target, `ask:${ask.id}`);
});

test('a blocking Ask cannot be answered twice, and an answer must be one of its options', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'ask', ask: DECISION }] });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();
  await start(kiln, ticket);
  const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 })).payload;

  const wrong = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Postgres' });
  assert.equal(wrong.status, 400);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'SQLite' });
  const again = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Tracker' });
  assert.equal(again.status, 409);
});

test('a non-blocking Ask lets the Session carry on with its recommendation, and a changed answer reaches it while it runs', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'ask', ask: { ...DECISION, type: 'question', blocking: false } },
      { do: 'wait_for_message' },
      { do: 'finish', reason: 'stopped' },
    ],
  });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 })).payload;
  assert.equal(ask.blocking, false);
  await progress(events, /^carrying on with: SQLite$/);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'running');
  assert.deepEqual((await kiln.api<Ask[]>('GET', '/api/asks')).map((a) => a.id), [ask.id], 'still open in Needs you');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Tracker' });
  await progress(events, /^answer changed: Tracker$/);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'SQLite' });
  await progress(events, /^answer changed: SQLite$/);
  assert.equal((await kiln.api<Ask>('GET', `/api/asks/${ask.id}`)).answer, 'SQLite');

  await kiln.api('POST', `/api/test/widgets/fake-agent/commands`, { type: 'agent.send_message', sessionId: session.id, message: { kind: 'text', text: 'wrap up' } });
  await progress(events, /^heard: wrap up$/);
  for (;;) {
    const updated = await events.next<SessionUpdatedEvent>('session.updated', { timeoutMs: 15_000 });
    if (updated.payload.session.state === 'stopped') break;
  }
  const late = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Tracker' });
  assert.equal(late.status, 409, 'the Session has finished, so the answer can no longer change');
});

test('Permission Asks always block, and a malformed Ask comes back to the Session as a tool error', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'kiln_tool', name: 'raise_ask', input: { ...DECISION, type: 'permission', blocking: false } },
      { do: 'kiln_tool', name: 'raise_ask', input: { type: 'decision', question: 'Which?' } },
      { do: 'wait_for_message' },
    ],
  });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();

  await start(kiln, ticket);
  assert.equal((await progress(events, /^error: /)).payload.text, 'error: Permission Asks always block');
  assert.match((await progress(events, /^error: /)).payload.text!, /needs "why"/);
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), []);
});

test('a Session reads its own Item and artifacts through the Kiln tools', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'kiln_tool', name: 'read_item' },
      { do: 'kiln_tool', name: 'read_artifacts', input: { name: '.scratch/home-board/spec.md' } },
      { do: 'kiln_tool', name: 'read_artifacts', input: { name: 'nope.md' } },
      { do: 'wait_for_message' },
    ],
  });
  const { ticket } = await seededTicket(kiln);
  const events = await kiln.events();

  await start(kiln, ticket);
  const item = JSON.parse((await progress(events, /^\{/)).payload.text!) as Item;
  assert.equal(item.id, ticket.id);
  assert.equal(item.title, 'Draw the columns');
  assert.match((await progress(events, /Spec: Home board/)).payload.text!, /^# Spec: Home board\r?\n\r?\nStatus: ready-for-agent/);
  assert.match((await progress(events, /^error: /)).payload.text!, /No artifact "nope.md"/);
});

test('a Widget raises an Ask through the API and hears the answer on its command stream', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket } = await seededTicket(kiln);
  await kiln.installFakeAgent({
    script: [{ do: 'widget_ask', ask: { ...DECISION, type: 'review', itemId: ticket.id } }, { do: 'wait_for_message' }],
  });
  const events = await kiln.events();

  await start(kiln, ticket);
  const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 })).payload;
  assert.deepEqual(ask.raisedBy, { kind: 'widget', widgetId: 'fake-agent' });
  assert.equal(ask.type, 'review');
  assert.equal(ask.itemId, ticket.id);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Tracker' });
  await progress(events, /^widget heard: Tracker$/);
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=ask.raise');
  assert.equal(audit[0]?.actor.kind, 'widget');
});

test('Needs you lists open Asks by how much work each blocks, then oldest first', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket, items } = await seededTicket(kiln);
  const story = byTitle(items, 'Home board');
  const epic = byTitle(items, 'Board as home');
  const ask = (itemId: string, question: string, blocking: boolean) => ({
    do: 'widget_ask' as const,
    wait: false,
    ask: { ...DECISION, options: undefined, itemId, question, blocking },
  });
  await kiln.installFakeAgent({
    script: [
      ask(ticket.id, 'older ticket', true),
      ask(epic.id, 'epic, not blocking', false),
      ask(story.id, 'story', true),
      ask(ticket.id, 'newer ticket', true),
      { do: 'progress', text: 'raised them all' },
      { do: 'wait_for_message' },
    ],
  });
  const events = await kiln.events();

  await start(kiln, ticket);
  await progress(events, /^raised them all$/);
  const open = await kiln.api<Ask[]>('GET', '/api/asks');
  assert.deepEqual(open.map((a) => a.question), ['story', 'older ticket', 'newer ticket', 'epic, not blocking']);
  assert.equal(open[3]!.blocks, 0);
  assert.ok(open[0]!.blocks > open[1]!.blocks, 'the Story Ask holds up the Story and its Tickets');
});
