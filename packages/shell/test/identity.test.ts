import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Me, User } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const PHONE = { width: 390, height: 844 };

test('an Admin filters the audit log in the Shell', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  await kiln.as('vic').request('POST', '/api/test/echo', {});
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'Audit log' }).click();
  const rows = page.getByRole('table', { name: 'Audit log' }).locator('tbody tr');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);

  await page.getByLabel('Outcome').selectOption('refused');
  await page.getByRole('button', { name: 'Apply' }).click();

  await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length === 1);
  const row = await rows.first().innerText();
  assert.match(row, /vic/);
  assert.match(row, /POST \/api\/test\/echo/);
  assert.match(row, /refused/);
});

test('a tailnet user with no role is told they have no access', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });

  const page = await openShell(t, kiln, '/', { as: 'stranger@example.com' });

  await page.getByRole('heading', { name: 'No access yet' }).waitFor();
  assert.match(await page.locator('main').innerText(), /stranger@example\.com/);
  assert.equal(await page.getByRole('link', { name: 'Audit log' }).count(), 0);
});

test('an Admin gives people roles in Settings: one who connected with no role, and one added by login', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const stranger = await openShell(t, kiln, '/', { as: 'stranger@example.com' });
  await stranger.getByRole('heading', { name: 'No access yet' }).waitFor();
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'Settings' }).click();
  const users = page.getByRole('table', { name: 'Users and roles' });
  const row = users.getByRole('row').filter({ hasText: 'stranger@example.com' });
  await row.waitFor();
  await row.getByLabel('Role for stranger@example.com').selectOption('member');
  await row.getByRole('button', { name: 'Save' }).click();
  await row.getByRole('status').filter({ hasText: 'Saved' }).waitFor();

  await page.getByLabel('Login').fill('newcomer@example.com');
  await page.getByLabel('Role for the new person').selectOption('viewer');
  await page.getByRole('button', { name: 'Add person' }).click();
  await users.getByRole('row').filter({ hasText: 'newcomer@example.com' }).waitFor();

  const list = await kiln.api<User[]>('GET', '/api/users');
  assert.equal(list.find((u) => u.id === 'stranger@example.com')?.role, 'member');
  assert.equal(list.find((u) => u.id === 'newcomer@example.com')?.role, 'viewer');
});

test('a Viewer sees the board but no Admin pages', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });

  const page = await openShell(t, kiln, '/', { as: 'vic' });

  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Audit log' }).count(), 0);
});

test('the browser must send the CSRF token to change anything', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln);
  await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
  const { csrfToken } = await kiln.api<Me>('GET', '/api/me');

  const statuses = await page.evaluate(async (token) => {
    const post = (headers: Record<string, string>) => fetch('/api/test/echo', { method: 'POST', headers, body: '{}' }).then((r) => r.status);
    return [await post({}), await post({ 'x-kiln-csrf': token })];
  }, csrfToken);

  assert.deepEqual(statuses, [403, 200]);
});

test('the Shell fits a phone screen', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.api('POST', '/api/test/echo', { a: 'long '.repeat(40) });

  for (const path of ['/', '/audit']) {
    const page = await openShell(t, kiln, path, { viewport: PHONE });
    await page.getByRole('status').filter({ hasText: /^Connected$/ }).waitFor();
    if (path === '/audit') await page.getByRole('table', { name: 'Audit log' }).locator('tbody tr').first().waitFor();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px at phone width`);
    if (path === '/audit') assert.ok(await page.getByLabel('Outcome').isVisible());
  }
});
