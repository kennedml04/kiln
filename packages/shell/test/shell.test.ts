import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

test('the Shell loads from the core and shows it is connected', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);

  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  assert.equal(await page.title(), 'Kiln');
});

test('the Shell is dark unless the person switches to light, and remembers the choice', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  assert.equal(await theme(), 'dark');

  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  assert.equal(await theme(), 'light');
  await page.reload();
  await page.getByRole('button', { name: 'Switch to dark theme' }).waitFor();
  assert.equal(await theme(), 'light');
});

test('the Shell shows the connection drop as soon as the core goes away', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);
  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();

  await kiln.stop();

  await page.getByRole('status').filter({ hasText: /^Disconnected/ }).waitFor({ timeout: 5_000 });
});

test('the Shell is driven by the event stream, not by polling', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);
  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  const apiCalls: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) apiCalls.push(req.url());
  });

  await kiln.api('POST', '/api/test/echo', { from: 'test' });
  await page.getByTestId('last-event').filter({ hasText: 'test.echo' }).waitFor();
  await page.waitForTimeout(1_500);

  assert.deepEqual(apiCalls, []);
});
