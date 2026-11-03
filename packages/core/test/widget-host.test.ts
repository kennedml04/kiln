import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CoreStatus,
  WidgetInfo,
  WidgetReadyEvent,
  WidgetRegisteredEvent,
  WidgetStoppedEvent,
} from '@kiln/widget-sdk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWidgetSource, driveTestWidget, startTestKiln, type TestKiln, type WidgetSource } from '@kiln/testing';

const installWidget = async (kiln: TestKiln, source: WidgetSource) => {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
};

test("a Widget starts with a minimal environment: the OS basics and Kiln's own variables, never the core's tokens", async (t) => {
  const kiln = await startTestKiln(t, { env: { GH_TOKEN: 'leaked', ANTHROPIC_API_KEY: 'leaked', KILN_SECRET_THING: 'leaked' } });
  await installWidget(kiln, createWidgetSource(t));

  const names = await driveTestWidget(kiln).envNames();
  const upper = names.map((n) => n.toUpperCase());
  for (const leaked of ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'KILN_SECRET_THING', 'KILN_TEST_SETUP_DONE', 'KILN_TAILSCALE_CLI']) {
    assert.ok(!upper.includes(leaked), `${leaked} is not passed on`);
  }
  for (const kept of ['PATH', 'KILN_API_URL', 'KILN_WIDGET_ID', 'KILN_WIDGET_TOKEN', 'KILN_WIDGET_CONFIG', 'KILN_WIDGET_DATA_DIR']) {
    assert.ok(upper.includes(kept), `${kept} is passed on`);
  }
  if (process.platform === 'win32') for (const kept of ['SYSTEMROOT', 'TEMP']) assert.ok(upper.includes(kept), `${kept} is passed on`);
});

test('a Widget gets a data folder only when its Manifest asks for one', async (t) => {
  const kiln = await startTestKiln(t);
  await installWidget(kiln, createWidgetSource(t, { manifest: { id: 'no-data', needs: { dataFolder: false } } }));
  await installWidget(kiln, createWidgetSource(t, { manifest: { id: 'with-data' } }));

  assert.equal(existsSync(join(kiln.dataDir, 'widgets', 'no-data', 'data')), false);
  assert.equal(existsSync(join(kiln.dataDir, 'widgets', 'with-data', 'data')), true);
});

test('the harness installs the fake Agent and its registration arrives over SSE', async (t) => {
  const kiln = await startTestKiln(t);
  const events = await kiln.events();

  const agent = await kiln.installFakeAgent();

  const registered = await events.next<WidgetRegisteredEvent>('widget.registered');
  assert.equal(registered.payload.widgetId, agent.widgetId);
  assert.deepEqual(registered.payload.agents.map((a) => a.id), ['fake']);
  const ready = await events.next<WidgetReadyEvent>('widget.ready');
  assert.equal(ready.payload.widgetId, agent.widgetId);
});

test('Widget calls without a valid credential are refused', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent();
  const call = (headers: Record<string, string>) =>
    fetch(`${kiln.url}/api/widget/register`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  assert.equal((await call({})).status, 401);
  assert.equal((await call({ authorization: 'Bearer not-a-real-credential' })).status, 401);
  const events = await fetch(`${kiln.url}/api/widget/commands`, { headers: { authorization: 'Bearer AAAA' } });
  assert.equal(events.status, 401);
});

test('a Widget is stopped without restarting the core', async (t) => {
  const kiln = await startTestKiln(t);
  const before = await kiln.api<CoreStatus>('GET', '/api/status');
  const agent = await kiln.installFakeAgent();
  const [running] = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  assert.equal(running?.state, 'ready');
  const pid = running!.pid!;
  const events = await kiln.events();

  const stopped = await agent.stopWidget();

  assert.equal(stopped.state, 'stopped');
  await events.next<WidgetStoppedEvent>('widget.stopped');
  assert.throws(() => process.kill(pid, 0), 'the Widget process is gone');
  const after = await kiln.api<CoreStatus>('GET', '/api/status');
  assert.equal(after.pid, before.pid);
  assert.equal(after.startedAt, before.startedAt);
});

test('a Widget can be started again after it was stopped', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent();
  await agent.stopWidget();

  const again = await kiln.installFakeAgent();

  assert.equal(again.widgetId, agent.widgetId);
  const [info] = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  assert.equal(info?.state, 'ready');
});
