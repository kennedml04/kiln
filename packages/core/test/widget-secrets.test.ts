// A test core keeps secrets in memory, never in this PC's real credential store. The one test of
// the real Windows Credential Locker runs only with KILN_REAL_CREDENTIALS=1, uses a throwaway fake
// value under its own test core's namespace, and removes it when done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEntry, Manifest, WidgetSecrets } from '@kiln/widget-sdk';
import { createWidgetSource, driveTestWidget, startTestKiln, type Cleanup, type TestKiln } from '@kiln/testing';

const windows = process.platform === 'win32';
const realVault = windows && process.env.KILN_REAL_CREDENTIALS === '1';

/** Reads (or removes) one entry of the Windows credential store directly, the way an Admin could. */
const vault = (op: 'get' | 'remove', resource: string, account: string): string | null => {
  const script = `
    [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
    $v = New-Object Windows.Security.Credentials.PasswordVault
    try { $c = $v.Retrieve('${resource}', '${account}') } catch { exit 0 }
    if ('${op}' -eq 'remove') { $v.Remove($c); exit 0 }
    $c.RetrievePassword(); [Console]::Out.Write($c.Password)`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return out === '' ? null : out;
};

const startWidget = async (t: Cleanup, kiln: TestKiln, manifest: Partial<Manifest>) => {
  const source = createWidgetSource(t, { manifest });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
  return driveTestWidget(kiln, source.manifest.id);
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const fakeValue = () => `fake-secret-${randomBytes(8).toString('hex')}`;

test('a declared secret is handed only to its Widget, and a test core never writes the real credential store', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const widget = await startWidget(t, kiln, { needs: { secrets: ['api-token'] } });
  const other = await startWidget(t, kiln, { id: 'other', needs: { secrets: ['api-token'] } });
  const value = fakeValue();

  assert.equal((await kiln.as('mo').request('PUT', '/api/widgets/test-widget/secrets/api-token', { value })).status, 403, 'Admins only');
  const set = await kiln.request('PUT', '/api/widgets/test-widget/secrets/api-token', { value });
  assert.equal(set.status, 200);
  const listed = await kiln.api<WidgetSecrets>('GET', '/api/widgets/test-widget/secrets');
  t.after(() => {
    // Only reached if the core wrote the real store after all: never leave a test entry behind.
    if (windows) for (const e of listed.entries) vault('remove', e.location.resource, e.location.account);
  });

  assert.equal(listed.store, 'test-memory', 'a test core keeps secrets in memory');
  assert.deepEqual(listed.entries.map((e) => [e.name, e.set]), [['api-token', true]]);
  assert.ok(!JSON.stringify(listed).includes(value), 'the value is never shown back');
  if (windows) assert.equal(vault('get', listed.entries[0]!.location.resource, listed.entries[0]!.location.account), null);
  for (const file of filesUnder(kiln.dataDir)) {
    assert.ok(!readFileSync(file).includes(value), `${file} must not hold the secret`);
  }
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit');
  assert.ok(!JSON.stringify(audit).includes(value), 'nor the audit log');

  assert.deepEqual((await widget.call('GET', '/api/widget/secrets/api-token')).body, { name: 'api-token', value });
  assert.equal((await other.call('GET', '/api/widget/secrets/api-token')).status, 404, "another Widget gets only its own secrets");
  assert.equal((await kiln.request('GET', '/api/widget/secrets/api-token')).status, 401);

  await kiln.api('DELETE', '/api/widgets/test-widget/secrets/api-token');
  assert.equal((await widget.call('GET', '/api/widget/secrets/api-token')).status, 404);
});

test('a Widget gets no secret it was not granted, and removing it removes its secrets', async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln, { needs: { secrets: ['api-token'] } });
  const value = fakeValue();

  assert.equal((await kiln.request('PUT', '/api/widgets/test-widget/secrets/other-token', { value })).status, 404, 'not declared');
  const undeclared = await widget.call<{ reason: string }>('GET', '/api/widget/secrets/other-token');
  assert.equal(undeclared.status, 403);
  assert.equal(undeclared.body.reason, 'grant');

  await kiln.api('PUT', '/api/widgets/test-widget/secrets/api-token', { value });
  await kiln.api('DELETE', '/api/widgets/test-widget');
  // Installed again, the same Widget finds its old secret gone.
  const again = await startWidget(t, kiln, { needs: { secrets: ['api-token'] } });
  assert.equal((await again.call('GET', '/api/widget/secrets/api-token')).status, 404);
  const listed = await kiln.api<WidgetSecrets>('GET', '/api/widgets/test-widget/secrets');
  assert.deepEqual(listed.entries.map((e) => [e.name, e.set]), [['api-token', false]]);
});

test('with KILN_REAL_CREDENTIALS=1 a secret goes to the real Windows Credential Locker', { skip: !realVault && 'set KILN_REAL_CREDENTIALS=1 on Windows' }, async (t) => {
  const kiln = await startTestKiln(t, { env: { KILN_TEST_OS_CREDENTIALS: '1' } });
  const widget = await startWidget(t, kiln, { needs: { secrets: ['api-token'] } });
  const value = fakeValue();
  await kiln.api('PUT', '/api/widgets/test-widget/secrets/api-token', { value });
  const listed = await kiln.api<WidgetSecrets>('GET', '/api/widgets/test-widget/secrets');
  const at = listed.entries[0]!.location;
  t.after(() => vault('remove', at.resource, at.account));

  assert.equal(listed.store, 'windows-credential-locker');
  assert.equal(vault('get', at.resource, at.account), value);
  assert.deepEqual((await widget.call('GET', '/api/widget/secrets/api-token')).body, { name: 'api-token', value });
  await kiln.api('DELETE', '/api/widgets/test-widget');
  assert.equal(vault('get', at.resource, at.account), null);
});
