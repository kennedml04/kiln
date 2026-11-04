import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { AuditEntry, Me, User } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';

const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((info) => info && info.family === 'IPv4' && !info.internal)?.address;

test('in Local mode the person at the PC is Admin, with no login', async (t) => {
  const kiln = await startTestKiln(t);

  const me = await kiln.api<Me>('GET', '/api/me');

  assert.equal(me.login, 'local');
  assert.equal(me.role, 'admin');
  assert.deepEqual(me.actor, { kind: 'user', id: 'local' });
  assert.ok(me.csrfToken.length >= 32);
});

test('in Local mode Kiln is not reachable from the network', async (t) => {
  const address = lanAddress();
  if (!address) return t.skip('this machine has no LAN address');
  const kiln = await startTestKiln(t);

  await assert.rejects(fetch(`http://${address}:${kiln.port}/api/status`, { signal: AbortSignal.timeout(3_000) }));
});

test('in Tailscale mode an unknown tailnet user sees nothing until an Admin gives them a role', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const alice = kiln.as('alice@example.com');

  const me = await alice.api<Me>('GET', '/api/me');
  assert.equal(me.login, 'tailscale');
  assert.equal(me.role, null);
  assert.deepEqual(me.actor, { kind: 'user', id: 'alice@example.com' });
  assert.equal((await alice.request('GET', '/api/status')).status, 403);
  assert.equal((await alice.request('GET', '/api/events')).status, 403);

  const users = await kiln.api<User[]>('GET', '/api/users');
  assert.deepEqual(users.map((u) => [u.id, u.role]), [['alice@example.com', null]]);

  await kiln.api('PUT', '/api/users/alice%40example.com', { role: 'viewer' });

  assert.equal((await alice.request('GET', '/api/status')).status, 200);
  assert.equal((await alice.api<Me>('GET', '/api/me')).role, 'viewer');
});

test('the person at the PC is still Admin in Tailscale mode', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });

  const me = await kiln.api<Me>('GET', '/api/me');

  assert.equal(me.role, 'admin');
  assert.deepEqual(me.actor, { kind: 'user', id: 'local' });
});

test('a Viewer can read but not change anything, and the refusal is audited', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  const vic = kiln.as('vic');

  assert.equal((await vic.request('GET', '/api/status')).status, 200);
  const refused = await vic.request('POST', '/api/test/echo', { hi: 1 });

  assert.equal(refused.status, 403);
  const [entry] = await kiln.api<AuditEntry[]>('GET', '/api/audit?actorId=vic');
  assert.equal(entry?.outcome, 'refused');
  assert.equal(entry?.action, 'POST /api/test/echo');
  assert.equal(entry?.reason, 'role');
});

test('a Member can do daily work but cannot reach Admin settings', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const mo = kiln.as('mo');

  assert.equal((await mo.request('POST', '/api/test/echo', { hi: 1 })).status, 200);
  assert.equal((await mo.request('GET', '/api/users')).status, 403);
  assert.equal((await mo.request('PUT', '/api/users/mo', { role: 'admin' })).status, 403);
  assert.equal((await mo.request('GET', '/api/audit')).status, 403);
  assert.equal((await mo.request('POST', '/api/core/stop')).status, 403);

  const refusals = await kiln.api<AuditEntry[]>('GET', '/api/audit?actorId=mo&outcome=refused');
  assert.deepEqual(refusals.map((e) => e.action).sort(), ['GET /api/audit', 'GET /api/users', 'core.stop', 'user.set_role']);
});

test('a mutating browser request without a valid CSRF token is refused and audited', async (t) => {
  const kiln = await startTestKiln(t);
  const { csrfToken } = await kiln.api<Me>('GET', '/api/me');
  const browser = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' };

  const missing = await kiln.request('POST', '/api/test/echo', { n: 1 }, browser);
  const wrong = await kiln.request('POST', '/api/test/echo', { n: 2 }, { ...browser, 'x-kiln-csrf': 'nope' });
  const valid = await kiln.request('POST', '/api/test/echo', { n: 3 }, { 'sec-fetch-site': 'same-origin', 'x-kiln-csrf': csrfToken });

  assert.equal(missing.status, 403);
  assert.equal(wrong.status, 403);
  assert.equal(valid.status, 200);
  const refused = await kiln.api<AuditEntry[]>('GET', '/api/audit?outcome=refused');
  assert.deepEqual(refused.map((e) => e.reason), ['csrf', 'csrf']);
});

test('a request for another host name is refused, so a rebinding page cannot read the CSRF token', async (t) => {
  const kiln = await startTestKiln(t);
  const get = (host: string) =>
    new Promise<number>((done, fail) => {
      request({ host: '127.0.0.1', port: kiln.port, path: '/api/me', headers: { host } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      })
        .on('error', fail)
        .end();
    });

  assert.equal(await get('evil.example'), 403);
  assert.equal(await get(`evil.example:${kiln.port}`), 403);
  assert.equal(await get(`localhost:${kiln.port}`), 200);
  assert.equal(await get(`127.0.0.1:${kiln.port}`), 200);
});

test('every change is in the audit log with its actor', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  await kiln.as('mo').api('POST', '/api/test/echo', { from: 'mo' });

  const log = await kiln.api<AuditEntry[]>('GET', '/api/audit');

  const changes = log.filter((e) => e.method !== 'GET').map((e) => ({ actor: e.actor, action: e.action, outcome: e.outcome, target: e.target, detail: e.detail }));
  assert.deepEqual(changes, [
    { actor: { kind: 'user', id: 'mo' }, action: 'POST /api/test/echo', outcome: 'allowed', target: undefined, detail: undefined },
    { actor: { kind: 'user', id: 'local' }, action: 'user.set_role', outcome: 'allowed', target: 'user:mo', detail: { from: null, to: 'member' } },
  ]);
  assert.ok(log.every((e) => typeof e.at === 'string' && e.id > 0));
});

test('reads are not audited, but a failed change is', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.api('GET', '/api/status');

  const bad = await kiln.request('PUT', '/api/users/someone', { role: 'owner' });

  assert.equal(bad.status, 400);
  const log = await kiln.api<AuditEntry[]>('GET', '/api/audit');
  assert.deepEqual(log.map((e) => [e.action, e.outcome, e.status]), [['user.set_role', 'failed', 400]]);
});

test('Admins can filter the audit log', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  await kiln.as('vic').request('POST', '/api/test/echo', {});
  await kiln.as('mo').request('POST', '/api/test/echo', {});

  const byAction = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=set_role');
  const byOutcome = await kiln.api<AuditEntry[]>('GET', '/api/audit?outcome=allowed&action=echo');
  const limited = await kiln.api<AuditEntry[]>('GET', '/api/audit?limit=1');
  const future = await kiln.api<AuditEntry[]>(`GET`, `/api/audit?since=${encodeURIComponent('2999-01-01T00:00:00Z')}`);

  assert.deepEqual(byAction.map((e) => e.target), ['user:mo', 'user:vic']);
  assert.deepEqual(byOutcome.map((e) => e.actor), [{ kind: 'user', id: 'mo' }]);
  assert.equal(limited.length, 1);
  assert.deepEqual(future, []);
});

test('a Widget is audited as itself, and only an Admin can install one', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  const fake = await kiln.installFakeAgent();
  const refused = await kiln.as('mo').request('POST', '/api/widgets', { source: '.' });

  assert.equal(refused.status, 403);
  const entries = await kiln.api<AuditEntry[]>('GET', '/api/audit?actorKind=widget');
  assert.ok(entries.some((e) => e.action === 'POST /api/widget/register' && e.outcome === 'allowed'));
  assert.ok(entries.every((e) => e.actor.kind === 'widget' && e.actor.id === fake.widgetId));
  const [install] = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=widget.install&outcome=allowed');
  assert.deepEqual(install?.actor, { kind: 'user', id: 'local' });
});

test('only an Admin can stop the core', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/ada', { role: 'admin' });

  const stopped = await kiln.as('ada').request('POST', '/api/core/stop');

  assert.equal(stopped.status, 202);
});

// `tailscale serve` forwards tailnet callers to Kiln from this PC, adding headers that name them.
const viaServe = (login: string, name?: string): Record<string, string> => ({
  'x-forwarded-for': '100.64.0.7',
  'tailscale-user-login': login,
  ...(name ? { 'tailscale-user-name': name } : {}),
});

test('in Tailscale mode a request through tailscale serve is the tailnet user it names, with their role and in the audit log', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/alice%40example.com', { role: 'member' });

  const me = await kiln.request<Me>('GET', '/api/me', undefined, viaServe('alice@example.com', 'Alice'));
  assert.equal(me.body.role, 'member');
  assert.deepEqual(me.body.actor, { kind: 'user', id: 'alice@example.com', name: 'Alice' });

  assert.equal((await kiln.request('POST', '/api/test/echo', { hi: 1 }, viaServe('alice@example.com'))).status, 200);
  assert.equal((await kiln.request('POST', '/api/core/stop', undefined, viaServe('alice@example.com'))).status, 403);
  const changes = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=echo');
  assert.deepEqual(
    changes.map((e) => [e.actor, e.outcome]),
    [[{ kind: 'user', id: 'alice@example.com', name: 'Alice' }, 'allowed']],
  );
});

test("tailscale serve's encoded display names are decoded", async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });

  const me = await kiln.request<Me>('GET', '/api/me', undefined, viaServe('jorg@example.com', '=?utf-8?q?J=C3=B6rg_M?='));

  assert.deepEqual(me.body.actor, { kind: 'user', id: 'jorg@example.com', name: 'Jörg M' });
});

test('in Tailscale mode a tailnet user with no role gets no access through tailscale serve', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });

  const me = await kiln.request<Me>('GET', '/api/me', undefined, viaServe('bob@example.com'));
  assert.equal(me.body.role, null);
  assert.deepEqual(me.body.actor, { kind: 'user', id: 'bob@example.com' });
  assert.equal((await kiln.request('GET', '/api/status', undefined, viaServe('bob@example.com'))).status, 403);
  assert.equal((await kiln.request('GET', '/api/events', undefined, viaServe('bob@example.com'))).status, 403);
});

for (const login of ['local', 'tailscale'] as const) {
  test(`in ${login} mode a proxied request that names no caller gets no access`, async (t) => {
    const kiln = await startTestKiln(t, { login });

    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const headers = { [header]: header === 'forwarded' ? 'for=203.0.113.9' : '203.0.113.9' };
      const me = await kiln.request<Me>('GET', '/api/me', undefined, headers);
      assert.equal(me.body.role, null, header);
      assert.equal((await kiln.request('GET', '/api/status', undefined, headers)).status, 403, header);
      assert.equal((await kiln.request('GET', '/api/events', undefined, headers)).status, 403, header);
      assert.equal((await kiln.request('POST', '/api/core/stop', undefined, headers)).status, 403, header);
    }
    // The person at the PC, with no proxy in between, is still Admin.
    assert.equal((await kiln.api<Me>('GET', '/api/me')).role, 'admin');
  });
}

test('in Local mode a request naming a Tailscale user gets no access', async (t) => {
  const kiln = await startTestKiln(t);

  assert.equal((await kiln.request<Me>('GET', '/api/me', undefined, viaServe('alice@example.com'))).body.role, null);
  assert.equal((await kiln.request('GET', '/api/status', undefined, { 'tailscale-user-login': 'alice@example.com' })).status, 403);
});
