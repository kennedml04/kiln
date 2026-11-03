import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetSource, startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

test('an Admin sees what a Widget needs on the Widgets page and approves it', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t, { manifest: { needs: { network: ['api.example.com'] } } });
  const old = createWidgetSource(t, { manifest: { id: 'old', name: 'Old Widget', coreApi: '^2.0.0' } });
  await kiln.api('PUT', '/api/org-policy/widget-sources', { allowed: [source.path, old.path] });
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', '/api/widgets', { source: old.path });
  await kiln.api('POST', '/api/widgets/old/approve');
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'Widgets' }).click();
  const card = page.getByRole('article', { name: 'Test Widget' });
  await card.waitFor();
  assert.match(await card.innerText(), /awaiting approval/i);
  assert.match(await card.innerText(), /network: api\.example\.com/);
  assert.match(await card.innerText(), new RegExp(source.head().slice(0, 7)));
  assert.ok((await page.getByRole('region', { name: 'Allowed sources' }).innerText()).includes(source.path));

  await card.getByRole('button', { name: 'Approve' }).click();

  await card.getByText('ready', { exact: true }).waitFor();
  const oldCard = page.getByRole('article', { name: 'Old Widget' });
  assert.match(await oldCard.innerText(), /Incompatible: it supports core API \^2\.0\.0/);
});

test('the Widgets page shows a crashed Widget as unhealthy, and a Viewer gets no buttons', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  const source = createWidgetSource(t);
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path, config: { crash: true } });
  await kiln.api('POST', '/api/widgets/test-widget/approve');
  await events.next('widget.unhealthy', { timeoutMs: 10_000 });

  const page = await openShell(t, kiln, '/widgets', { as: 'vic' });

  const card = page.getByRole('article', { name: 'Test Widget' });
  await card.getByText('unhealthy', { exact: true }).waitFor();
  assert.match(await card.innerText(), /code 3/);
  assert.equal(await card.getByRole('button').count(), 0);
});
