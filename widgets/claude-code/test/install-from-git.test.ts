// The Widget as Kiln installs it from the public repo: a git checkout with no node_modules, its
// npm packages installed from its own lock file and the SDK provided by the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WidgetInfo } from '@kiln/widget-sdk';
import { createWidgetRepoCopy, startTestKiln } from '@kiln/testing';

test('installed from a git repo, the Widget loads its real packages, reaches ready and offers its models', async (t) => {
  const repo = createWidgetRepoCopy(t, ['claude-code']);
  // npm installs from its cache only: a test never needs the network.
  const kiln = await startTestKiln(t, { env: { npm_config_offline: 'true' } });
  const events = await kiln.events();

  const installed = await kiln.api<WidgetInfo>('POST', '/api/widgets', { source: repo.path, path: 'widgets/claude-code', config: { model: 'claude-haiku-5-5' } });
  assert.equal(installed.pin.kind, 'git');
  await kiln.api('POST', '/api/widgets/claude-code/approve');
  await events.next('widget.ready', { timeoutMs: 60_000 });
  events.close();

  const widget = (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === 'claude-code')!;
  assert.equal(widget.state, 'ready');
  assert.deepEqual(widget.agents.map((a) => a.id), ['claude-code']);
  assert.ok(widget.agents[0]!.models?.some((m) => m.id === 'claude-opus-5-5'));
});
