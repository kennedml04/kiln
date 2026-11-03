import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKilnEvent } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';

test('the fake Agent edits, commits and reports usage, a quota reading and a Digest', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({
    script: [
      { do: 'write', path: 'src/hello.txt', content: 'hello\n' },
      { do: 'commit', message: 'Add hello' },
      { do: 'usage', inputTokens: 120, outputTokens: 30, costUsd: 0.01 },
      { do: 'usage', inputTokens: 50, outputTokens: 5, subagent: { description: 'explore' } },
      { do: 'quota', reading: { window: 'week', percent: 42, resetsAt: '2026-11-09T00:00:00.000Z' } },
      { do: 'digest', text: 'Added hello.' },
      { do: 'finish' },
    ],
  });
  const events = await kiln.events();

  const sessionId = await agent.startSession();

  const finished = await events.next<AgentKilnEvent<'finished'>>('agent.finished');
  assert.equal(finished.payload.sessionId, sessionId);
  assert.equal(finished.payload.widgetId, agent.widgetId);
  assert.equal(finished.payload.reason, 'completed');
  const first = await events.next<AgentKilnEvent<'usage'>>('agent.usage');
  const second = await events.next<AgentKilnEvent<'usage'>>('agent.usage');
  assert.deepEqual([first.payload.turn, first.payload.inputTokens, first.payload.costUsd], [1, 120, 0.01]);
  assert.deepEqual([second.payload.turn, second.payload.subagent], [2, { description: 'explore' }]);
  const quota = await events.next<AgentKilnEvent<'quota_reading'>>('agent.quota_reading');
  assert.equal(quota.payload.reading.window, 'week');
  assert.equal(quota.payload.reading.percent, 42);
  assert.equal(quota.payload.reading.model, null);
  const digest = await events.next<AgentKilnEvent<'digest_written'>>('agent.digest_written');
  assert.equal(digest.payload.digest, 'Added hello.');
  assert.equal(readFileSync(join(kiln.repo.path, 'src/hello.txt'), 'utf8'), 'hello\n');
  assert.equal(kiln.repo.git('log', '-1', '--format=%s').trim(), 'Add hello');
  assert.equal(kiln.repo.git('status', '--porcelain').trim(), '');
});

test('the fake Agent waits for a message and for the answer to its permission request', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({
    script: [{ do: 'wait_for_message' }, { do: 'permission', action: 'shell', detail: 'npm test' }],
  });
  const events = await kiln.events();
  const sessionId = await agent.startSession();

  await agent.sendMessage(sessionId, { kind: 'text', text: 'go on' });
  const heard = await events.next<AgentKilnEvent<'progress'>>('agent.progress');
  assert.equal(heard.payload.text, 'heard: go on');
  const request = await events.next<AgentKilnEvent<'permission_request'>>('agent.permission_request');
  assert.deepEqual([request.payload.action, request.payload.detail], ['shell', 'npm test']);

  await agent.sendMessage(sessionId, { kind: 'permission_answer', requestId: request.payload.requestId, decision: 'deny' });

  const answered = await events.next<AgentKilnEvent<'progress'>>('agent.progress');
  assert.equal(answered.payload.text, 'permission deny');
  assert.equal((await events.next<AgentKilnEvent<'finished'>>('agent.finished')).payload.reason, 'completed');
});

test('a looping fake Agent can be interrupted, resumed and stopped', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({
    script: [{ do: 'tool', name: 'read_file', input: { path: 'a.ts' }, times: 'forever', intervalMs: 20 }],
  });
  const events = await kiln.events();
  const sessionId = await agent.startSession();
  const call = await events.next<AgentKilnEvent<'progress'>>('agent.progress');
  assert.deepEqual(call.payload.tool, { name: 'read_file', input: { path: 'a.ts' } });

  await agent.interrupt(sessionId);
  assert.equal((await events.next<AgentKilnEvent<'finished'>>('agent.finished')).payload.reason, 'interrupted');
  await agent.resume(sessionId);
  const events2 = await kiln.events();
  await events2.next('agent.progress');
  await agent.stopSession(sessionId);

  assert.equal((await events2.next<AgentKilnEvent<'finished'>>('agent.finished')).payload.reason, 'stopped');
});

test('a script change applies to the next Session', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent();
  const events = await kiln.events();

  agent.setScript([{ do: 'progress', text: 'second script' }]);
  await agent.startSession();

  assert.equal((await events.next<AgentKilnEvent<'progress'>>('agent.progress')).payload.text, 'second script');
});
