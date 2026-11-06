import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KilnEvent, OpenChatResult, ScratchChat, SessionInfo, SessionMessageEvent, ThreadEntry, UsageRollup } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type EventStream, type TestKiln } from '@kiln/testing';

type ProgressEvent = KilnEvent<'session.progress', { sessionId: string; itemId: string; text?: string }>;

const startKiln = (t: Parameters<typeof startTestKiln>[0]) => startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });

async function progress(events: EventStream, match: RegExp, timeoutMs = 15_000): Promise<ProgressEvent> {
  for (;;) {
    const event = await events.next<ProgressEvent>('session.progress', { timeoutMs });
    if (event.payload.text && match.test(event.payload.text)) return event;
  }
}

const open = (kiln: TestKiln, text: string) => kiln.api<OpenChatResult>('POST', '/api/chats', { text });

test('a first message opens a chat and starts its Session at once, with no Project and no worktree; later messages go to the same Session', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const events = await kiln.events();

  const opened = await open(kiln, 'How does the Tracker pick a key?\nMore detail here');

  assert.equal(opened.chat.title, 'How does the Tracker pick a key?');
  assert.equal(opened.chat.pinned, false);
  assert.deepEqual(opened.chat.stories, []);
  const started = await events.next<KilnEvent<'session.started', { session: SessionInfo }>>('session.started');
  const { session } = started.payload;
  assert.equal(session.id, opened.sessionId);
  assert.equal(session.itemId, `chat:${opened.chat.id}`);
  assert.equal(session.projectId, '');
  assert.equal(session.stage, 'chat');
  assert.equal(session.role, 'chat');
  assert.equal(session.worktree, null);
  await progress(events, /^heard: How does the Tracker pick a key\?/);
  // The chat's scratch folder exists, empty, and is no git repo.
  const folder = join(kiln.dataDir, 'chats', opened.chat.id);
  assert.ok(existsSync(folder));
  assert.deepEqual(readdirSync(folder), []);

  const second = await kiln.api('POST', `/api/chats/${opened.chat.id}/messages`, { text: 'And why?' });
  assert.deepEqual(second, { delivery: 'running', sessionId: opened.sessionId });
  await progress(events, /^heard: And why\?$/);

  const thread = await kiln.api<ThreadEntry[]>('GET', `/api/chats/${opened.chat.id}/thread`);
  const said = thread.filter((e): e is SessionMessageEvent & ThreadEntry => e.type === 'session.message');
  assert.deepEqual(said.map((m) => m.payload.text), ['How does the Tracker pick a key?\nMore detail here', 'And why?']);
  const fetched = await kiln.api<ScratchChat>('GET', `/api/chats/${opened.chat.id}`);
  assert.equal(fetched.running, true);
  const listed = await kiln.api<ScratchChat[]>('GET', '/api/chats');
  assert.deepEqual(listed.map((c) => c.id), [opened.chat.id]);
  await assert.rejects(kiln.api('GET', '/api/chats/nope'), /404/);
  await assert.rejects(open(kiln, '  '), /400/);
});

test('a chat starts even when the agents pool is full, and takes no pool slot', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 0 });

  const opened = await open(kiln, 'Quick question');

  assert.ok(opened.sessionId);
  const state = await kiln.api<{ pools: { name: string; active: number }[]; queue: unknown[] }>('GET', '/api/scheduler');
  assert.equal(state.pools.find((p) => p.name === 'agents')!.active, 0);
  assert.deepEqual(state.queue, []);
});

test('Stop all pauses a running chat and refuses new chats and messages with 409', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const events = await kiln.events();
  const opened = await open(kiln, 'First');
  await events.next('session.started');
  await until(async () => (await kiln.api<SessionInfo>('GET', `/api/sessions/${opened.sessionId}`)).state === 'running');

  await kiln.api('POST', '/api/scheduler/stop-all');

  const paused = await kiln.api<SessionInfo>('GET', `/api/sessions/${opened.sessionId}`);
  assert.equal(paused.state, 'paused');
  await assert.rejects(kiln.api('POST', `/api/chats/${opened.chat.id}/messages`, { text: 'more' }), /409.*Stop all is on/);
  await assert.rejects(open(kiln, 'new'), /409.*Stop all is on/);
  assert.equal((await kiln.api<ScratchChat[]>('GET', '/api/chats')).length, 1, 'a refused chat leaves nothing behind');
});

test('a chat Session runs under the chat Policy: network allowed, writes and commands denied', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'permission', action: 'network', detail: 'https://example.com' },
      { do: 'permission', action: 'worktree_write', detail: 'notes.md' },
      { do: 'permission', action: 'other_commands', detail: 'rm -rf x' },
      { do: 'finish', reason: 'error' },
    ],
  });
  const events = await kiln.events();
  await open(kiln, 'Look this up');
  const answers: string[] = [];
  while (answers.length < 3) {
    const e = await events.next<ProgressEvent>('session.progress', { timeoutMs: 15_000 });
    if (e.payload.text && /^permission /.test(e.payload.text)) answers.push(e.payload.text);
  }
  assert.deepEqual(answers.map((a) => a.split(' ')[1]), ['allow', 'deny', 'deny']);
  assert.deepEqual(await kiln.api('GET', '/api/asks'), [], 'a chat never raises a Permission Ask');
});

test('a chat\'s usage is recorded with no Project and rolls up under "Scratch chats"', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({
    script: [{ do: 'usage', inputTokens: 10, outputTokens: 5 }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }],
  });
  const events = await kiln.events();
  await open(kiln, 'Count me');
  await events.next('usage.recorded', { timeoutMs: 15_000 });

  const rollup = await kiln.api<UsageRollup[]>('GET', '/api/usage?by=project');
  assert.deepEqual(rollup.map((r) => r.key), ['Scratch chats']);
  assert.equal(rollup[0]!.turns, 1);
});

const DAY = 24 * 60 * 60 * 1000;
const advance = (kiln: TestKiln, days: number) => kiln.api('POST', '/api/test/clock', { advanceMs: days * DAY });
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('idle unpinned chats archive at 7 days, messages un-archive, and archived chats are deleted 30 days later', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'usage', inputTokens: 10, outputTokens: 5 }, { do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const events = await kiln.events();
  const idle = await open(kiln, 'Idle one');
  await events.next('usage.recorded', { timeoutMs: 15_000 });
  const kept = await open(kiln, 'Pinned one');
  await kiln.api('PATCH', `/api/chats/${kept.chat.id}`, { pinned: true });

  await advance(kiln, 8);
  const archived = await until(async () => (await kiln.api<ScratchChat[]>('GET', '/api/chats?archived=1')).map((c) => c.id));
  assert.deepEqual(archived, [idle.chat.id]);
  assert.deepEqual((await kiln.api<ScratchChat[]>('GET', '/api/chats')).map((c) => c.id), [kept.chat.id]);
  assert.equal((await kiln.api<ScratchChat>('GET', `/api/chats/${idle.chat.id}`)).running, false, 'its live Session was ended');

  // A message un-archives it.
  await kiln.api('POST', `/api/chats/${idle.chat.id}/messages`, { text: 'back again' });
  assert.equal((await kiln.api<ScratchChat>('GET', `/api/chats/${idle.chat.id}`)).archivedAt, undefined);

  // Archive by hand, then 30 days on it is deleted, folder and all; the pinned chat stays.
  await kiln.api('PATCH', `/api/chats/${idle.chat.id}`, { archived: true });
  assert.ok((await kiln.api<ScratchChat>('GET', `/api/chats/${idle.chat.id}`)).archivedAt);
  await advance(kiln, 31);
  await until(async () => (await kiln.api<ScratchChat[]>('GET', '/api/chats?archived=1')).length === 0);
  await assert.rejects(kiln.api('GET', `/api/chats/${idle.chat.id}`), /404/);
  assert.ok(await kiln.api<ScratchChat>('GET', `/api/chats/${kept.chat.id}`));
  // Archiving a pinned chat by hand unpins it; pinning an archived chat brings it back.
  const byHand = await kiln.api<ScratchChat>('PATCH', `/api/chats/${kept.chat.id}`, { archived: true });
  assert.ok(byHand.archivedAt);
  assert.equal(byHand.pinned, false);
  const pinned = await kiln.api<ScratchChat>('PATCH', `/api/chats/${kept.chat.id}`, { pinned: true, title: 'Renamed' });
  assert.equal(pinned.archivedAt, undefined);
  assert.equal(pinned.title, 'Renamed');
  assert.equal(existsSync(join(kiln.dataDir, 'chats', idle.chat.id)), false, 'its folder is gone');
  const rollup = await kiln.api<UsageRollup[]>('GET', '/api/usage?by=project');
  assert.ok((rollup.find((r) => r.key === 'Scratch chats')?.turns ?? 0) >= 1, 'usage stays');
});

test('raise_ask works in a chat: the Ask has no Project and shows in Needs you', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'ask', ask: { type: 'question', question: 'Which Project?', why: 'Need to know', recommendation: 'Kiln', blocking: true } },
      { do: 'finish', reason: 'error' },
    ],
  });
  const events = await kiln.events();
  const opened = await open(kiln, 'Ask me something');
  await progress(events, /^ask raised: /);

  const asks = await kiln.api<{ itemId: string; projectId: string }[]>('GET', '/api/asks');
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.itemId, `chat:${opened.chat.id}`);
  assert.equal(asks[0]!.projectId, '');
});

test('with no chat role set and an Agent with no default model, a chat runs on the Budget\'s Opus model, never Fable', async (t) => {
  const kiln = await startKiln(t);
  const models = ['claude-fable-test', 'claude-opus-test', 'claude-sonnet-test'];
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'error' }], model: null, models });
  await kiln.api('PUT', '/api/budgets/max', { kind: 'subscription', name: 'Max', models });
  const events = await kiln.events();

  const opened = await open(kiln, 'Which model am I on?');

  const started = await events.next<KilnEvent<'session.started', { session: SessionInfo }>>('session.started');
  assert.equal(started.payload.session.id, opened.sessionId);
  assert.equal(started.payload.session.model, 'claude-opus-test');
});

test("another Member gets 404 on someone else's chat, reading or patching it; an Admin can open it", async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale', env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  await kiln.api('PUT', '/api/users/mia', { role: 'member' });
  const mo = kiln.as('mo');
  const mia = kiln.as('mia');
  const { chat } = await mo.api<OpenChatResult>('POST', '/api/chats', { text: 'Mine only' });

  assert.equal((await mia.request('GET', `/api/chats/${chat.id}`)).status, 404);
  assert.equal((await mia.request('GET', `/api/chats/${chat.id}/thread`)).status, 404);
  assert.equal((await mia.request('PATCH', `/api/chats/${chat.id}`, { title: 'Taken' })).status, 404);
  assert.equal((await mia.request('POST', `/api/chats/${chat.id}/messages`, { text: 'hi' })).status, 404);
  assert.equal((await mo.request('PATCH', `/api/chats/${chat.id}`, { title: 'Still mine' })).status, 200);
  assert.equal((await kiln.api<ScratchChat>('GET', `/api/chats/${chat.id}`)).title, 'Still mine');
});
