import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Manifest, PanelContent } from '@kiln/widget-sdk';
import { createWidgetSource, driveTestWidget, startTestKiln, type Cleanup, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const startWidget = async (t: Cleanup, kiln: TestKiln, manifest: Partial<Manifest>, files?: Record<string, string>) => {
  const source = createWidgetSource(t, { manifest, ...(files ? { files } : {}) });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
  return driveTestWidget(kiln, source.manifest.id);
};

const gpus = (use: number): PanelContent => ({
  blocks: [
    { kind: 'stat', label: 'GPU use', value: use, unit: '%' },
    { kind: 'table', columns: ['GPU', 'Memory'], rows: [['RTX 4090', '20 GB']] },
    { kind: 'button', label: 'Refresh', action: 'refresh', input: { full: true } },
  ],
});

test("a Widget's declarative panel shows on Home, updates live, and its button runs the Widget's action", async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln, {
    provides: { panels: [{ id: 'gpus', title: 'GPUs', placement: 'home' }], actions: ['refresh'] },
  });
  await widget.call('PUT', '/api/widget/panels/gpus', gpus(40));
  const page = await openShell(t, kiln);

  const panel = page.getByRole('region', { name: 'GPUs' });
  await panel.getByText('40%').waitFor();
  assert.match(await panel.innerText(), /RTX 4090/);

  await widget.call('PUT', '/api/widget/panels/gpus', gpus(75));
  await panel.getByText('75%').waitFor();

  await panel.getByRole('button', { name: 'Refresh' }).click();
  const [action] = await widget.actions(1);
  assert.deepEqual(action, { type: 'widget.action', action: 'refresh', panelId: 'gpus', input: { full: true }, by: { kind: 'user', id: 'local' } });
});

/** An embedded page that probes what it can reach, then reports through the Shell's bridge. */
const PROBE_PAGE = `<!doctype html><p>probe</p><script>
const tryIt = (f) => { try { f(); return 'reachable'; } catch { return 'blocked'; } };
const report = (input) => parent.postMessage({ kiln: 'action', action: 'report', input }, '*');
const probe = async () => {
  let fetched = 'blocked';
  try { await fetch('/api/me'); fetched = 'reachable'; } catch {}
  let siblings = 0;
  for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] !== window && tryIt(() => parent.frames[i].document.body) === 'reachable') siblings++;
  report({
    shellDom: tryIt(() => parent.document.body.innerHTML),
    cookie: tryIt(() => document.cookie + parent.document.cookie),
    fetch: fetched,
    readableSiblings: siblings,
  });
};
addEventListener('message', (e) => { if (e.source === parent && e.data?.kiln === 'message') report({ echo: e.data.message }); });
probe();
</script>`;

test("an embedded page runs sandboxed: no Shell DOM, cookies, network or other Widgets, only its own Widget's bridge", async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln, '/widgets');
  await page.evaluate(() => (document.cookie = 'shell-cookie=fake-value'));
  const pageManifest = (id: string): Partial<Manifest> => ({
    id,
    name: id,
    provides: { panels: [{ id: 'rich', title: `Rich ${id}`, page: 'ui/index.html' }], actions: ['report'] },
  });
  const mine = await startWidget(t, kiln, pageManifest('test-widget'), { 'ui/index.html': PROBE_PAGE });
  const theirs = await startWidget(t, kiln, pageManifest('other'), { 'ui/index.html': PROBE_PAGE });

  const frame = page.getByRole('region', { name: 'Rich test-widget' }).locator('iframe');
  await frame.waitFor();
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
  await page.getByRole('region', { name: 'Rich other' }).locator('iframe').waitFor();

  const [probe] = await mine.actions(1);
  assert.deepEqual(probe?.input, { shellDom: 'blocked', cookie: 'blocked', fetch: 'blocked', readableSiblings: 0 });
  assert.equal(probe?.panelId, 'rich');
  assert.equal((await theirs.actions(1))[0]?.action, 'report', "each page's request reaches only its own Widget");

  await mine.call('POST', '/api/widget/panels/rich/messages', { ping: 1 });
  const [, echo] = await mine.actions(2);
  assert.deepEqual(echo?.input, { echo: { ping: 1 } });
  assert.equal((await theirs.actions(1)).length, 1, "another Widget's page gets none of its messages");
});
