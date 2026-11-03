import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Manifest, PanelContent, PanelView } from '@kiln/widget-sdk';
import { createWidgetSource, driveTestWidget, startTestKiln, type Cleanup, type TestKiln } from '@kiln/testing';

const PANEL_MANIFEST: Partial<Manifest> = {
  provides: {
    panels: [{ id: 'gpus', title: 'GPUs', placement: 'home' }],
    actions: ['refresh'],
  },
};

const startWidget = async (t: Cleanup, kiln: TestKiln, manifest: Partial<Manifest> = PANEL_MANIFEST, files?: Record<string, string>) => {
  const source = createWidgetSource(t, { manifest, ...(files ? { files } : {}) });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
  return driveTestWidget(kiln, source.manifest.id);
};

const content = (value: number): PanelContent => ({
  blocks: [
    { kind: 'stat', id: 'use', label: 'GPU use', value, unit: '%' },
    { kind: 'button', label: 'Refresh', action: 'refresh', input: { full: true } },
  ],
});

test('a declarative panel a Widget publishes is listed for the Shell and updates live', async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln);
  const listed = await kiln.api<PanelView[]>('GET', '/api/panels');
  assert.deepEqual(
    listed.map((p) => [p.widgetId, p.panelId, p.title, p.placement, p.kind, p.content]),
    [['test-widget', 'gpus', 'GPUs', 'home', 'declarative', null]],
  );
  const events = await kiln.events();

  assert.equal((await widget.call('PUT', '/api/widget/panels/gpus', content(40))).status, 200);
  const first = await events.next<{ type: string; id: number; at: string; payload: { panel: PanelView } }>('widget.panel_updated');
  assert.deepEqual(first.payload.panel.content, content(40));

  await widget.call('PUT', '/api/widget/panels/gpus', content(75));
  const second = await events.next<{ type: string; id: number; at: string; payload: { panel: PanelView } }>('widget.panel_updated');
  assert.equal((second.payload.panel.content?.blocks[0] as { value: number }).value, 75);
  assert.deepEqual((await kiln.api<PanelView[]>('GET', '/api/panels'))[0]?.content, content(75));
});

test("pressing a panel button sends the Widget its named action, and only for a Member", async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  const widget = await startWidget(t, kiln);

  const pressed = await kiln.request('POST', '/api/widgets/test-widget/actions/refresh', { panelId: 'gpus', input: { full: true } });

  assert.equal(pressed.status, 202);
  const [action] = await widget.actions(1);
  assert.deepEqual(action, { type: 'widget.action', action: 'refresh', panelId: 'gpus', input: { full: true }, by: { kind: 'user', id: 'local' } });
  assert.equal((await kiln.request('POST', '/api/widgets/test-widget/actions/wipe', {})).status, 404);
  assert.equal((await kiln.as('vic').request('POST', '/api/widgets/test-widget/actions/refresh', {})).status, 403);
});

const PAGE_MANIFEST: Partial<Manifest> = {
  provides: { panels: [{ id: 'rich', title: 'Rich view', page: 'ui/index.html' }], actions: ['report'] },
};

test("an embedded page is served only with a sandbox that takes away the Shell's origin", async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln, PAGE_MANIFEST, { 'ui/index.html': '<p>rich</p>', 'ui/app.js': 'void 0;', 'secret.txt': 'x' });
  const [panel] = await kiln.api<PanelView[]>('GET', '/api/panels');
  assert.equal(panel?.kind, 'page');

  const res = await fetch(`${kiln.url}${panel!.pageUrl}`);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<p>rich</p>');
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /sandbox allow-scripts(;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'none'/);
  const base = panel!.pageUrl!.replace(/index\.html$/, '');
  assert.equal((await fetch(`${kiln.url}${base}app.js`)).status, 200);
  assert.equal((await fetch(`${kiln.url}${base}..%2fsecret.txt`)).status, 404, 'only files in the page folder');
  assert.equal((await widget.call('PUT', '/api/widget/panels/rich', content(1))).status, 400, 'a page has no declarative content');

  const events = await kiln.events();
  assert.equal((await widget.call('POST', '/api/widget/panels/rich/messages', { hello: 1 })).status, 202);
  const message = await events.next<{ type: string; id: number; at: string; payload: unknown }>('widget.page_message');
  assert.deepEqual(message.payload, { widgetId: 'test-widget', panelId: 'rich', message: { hello: 1 } });
});

test('a Widget can only publish panels and buttons its Manifest declares', async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln);

  const undeclared = await widget.call<{ reason: string }>('PUT', '/api/widget/panels/other', content(1));
  assert.equal(undeclared.status, 403);
  assert.equal(undeclared.body.reason, 'grant');
  const badButton = { blocks: [{ kind: 'button', label: 'Wipe', action: 'wipe' }] };
  assert.equal((await widget.call('PUT', '/api/widget/panels/gpus', badButton)).status, 400);
  assert.equal((await widget.call('PUT', '/api/widget/panels/gpus', { blocks: [{ kind: 'script' }] })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/widget/panels/gpus', content(1))).status, 401, 'only the Widget itself publishes');
  assert.equal((await kiln.api<PanelView[]>('GET', '/api/panels'))[0]?.content, null);
});
