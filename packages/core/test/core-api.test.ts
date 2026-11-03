import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreStatus, TestEchoEvent } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';

test('a test core reports its own port and data folder', async (t) => {
  const kiln = await startTestKiln(t);

  const status = await kiln.api<CoreStatus>('GET', '/api/status');

  assert.equal(status.name, 'Kiln');
  assert.equal(status.port, kiln.port);
  assert.equal(status.dataDir, kiln.dataDir);
  assert.ok(status.uptimeMs >= 0);
});

test('the core creates its SQLite file in the data folder on first start', async (t) => {
  const kiln = await startTestKiln(t);

  assert.ok(existsSync(join(kiln.dataDir, 'kiln.sqlite')));
});

test('an API call raises an event that arrives over SSE', async (t) => {
  const kiln = await startTestKiln(t);
  const events = await kiln.events();

  await kiln.api('POST', '/api/test/echo', { hello: 'kiln' });

  const event = await events.next<TestEchoEvent>('test.echo');
  assert.deepEqual(event.payload, { hello: 'kiln' });
});

test('a reconnecting client gets the events it missed', async (t) => {
  const kiln = await startTestKiln(t);
  const first = await kiln.api<TestEchoEvent>('POST', '/api/test/echo', { n: 1 });
  await kiln.api('POST', '/api/test/echo', { n: 2 });

  const events = await kiln.events({ lastEventId: first.id });

  const missed = await events.next<TestEchoEvent>('test.echo');
  assert.deepEqual(missed.payload, { n: 2 });
});

test('the test harness keeps clear of the live Kiln and the old board', async (t) => {
  const kiln = await startTestKiln(t);

  assert.notEqual(kiln.port, 8300);
  assert.notEqual(kiln.port, 8195);
  const liveDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Kiln') : undefined;
  if (liveDir) assert.ok(!kiln.dataDir.toLowerCase().startsWith(liveDir.toLowerCase()));
  assert.equal(kiln.repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});
