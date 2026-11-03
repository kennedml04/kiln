import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditEntry, CoreStatus, Item, KilnEvent, Project, SessionInfo, StartResult, WidgetInfo, WidgetLockfile } from '@kiln/widget-sdk';
import { createFakeWidgetRepo, createWidgetSource, startTestKiln, type TestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

const readLock = (kiln: TestKiln) => JSON.parse(readFileSync(join(kiln.dataDir, 'widgets.lock.json'), 'utf8')) as WidgetLockfile;
const widget = async (kiln: TestKiln, id: string) => (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === id);

test('installing from a git repo pins the exact commit in the lockfile and waits for approval', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t);
  const pinned = source.head();

  const installed = await kiln.api<WidgetInfo>('POST', '/api/widgets', { source: source.path });

  assert.equal(installed.state, 'awaiting-approval');
  assert.equal(installed.pid, null);
  assert.equal(installed.pin.kind, 'git');
  assert.equal(installed.pin.commit, pinned);
  assert.equal(readLock(kiln).widgets['test-widget']?.commit, pinned);

  source.setManifest({ version: '1.1.0' });
  assert.equal((await widget(kiln, 'test-widget'))?.version, '1.0.0', 'a new commit in the source changes nothing');
});

test('nothing runs until an Admin approves the Manifest', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const source = createWidgetSource(t, { manifest: { needs: { network: ['api.example.com'] } } });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });

  assert.equal((await kiln.request('POST', '/api/widgets/test-widget/start')).status, 409);
  assert.equal((await kiln.as('mo').request('POST', '/api/widgets/test-widget/approve')).status, 403, 'only Admins approve');
  await assert.rejects(events.next('widget.started', { timeoutMs: 300 }));

  const approved = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/approve');

  assert.deepEqual(approved.grants?.needs, { dataFolder: true, network: ['api.example.com'] });
  assert.equal(approved.grants?.approvedBy, 'local');
  await events.next('widget.ready');
  assert.equal((await widget(kiln, 'test-widget'))?.state, 'ready');
});

test('a Widget whose core API range excludes this core is not started and shows why', async (t) => {
  const kiln = await startTestKiln(t);
  const { apiVersion } = await kiln.api<CoreStatus>('GET', '/api/status');
  const old = createWidgetSource(t, { manifest: { id: 'old', coreApi: '^2.0.0' } });
  const ranged = createWidgetSource(t, { manifest: { id: 'ranged', coreApi: '>=0.1.0 <1 || ^3' } });
  const events = await kiln.events();

  await kiln.api('POST', '/api/widgets', { source: old.path });
  const approved = await kiln.api<WidgetInfo>('POST', '/api/widgets/old/approve');

  assert.equal(approved.state, 'incompatible');
  assert.match(approved.problem ?? '', /\^2\.0\.0/);
  assert.ok(approved.problem?.includes(apiVersion));
  assert.equal((await kiln.request('POST', '/api/widgets/old/start')).status, 409);
  await assert.rejects(events.next('widget.started', { timeoutMs: 300 }));

  await kiln.api('POST', '/api/widgets', { source: ranged.path });
  assert.equal((await kiln.api<WidgetInfo>('POST', '/api/widgets/ranged/approve')).state, 'starting');
});

const installAndApprove = async (kiln: TestKiln, source: string, config?: unknown) => {
  await kiln.api('POST', '/api/widgets', { source, config });
  const { id } = (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).at(-1)!;
  return kiln.api<WidgetInfo>('POST', `/api/widgets/${id}/approve`);
};

test('a crashed Widget is restarted while the core stays up', async (t) => {
  const kiln = await startTestKiln(t);
  const core = await kiln.api<CoreStatus>('GET', '/api/status');
  const source = createWidgetSource(t);
  const events = await kiln.events();
  await installAndApprove(kiln, source.path);
  await events.next('widget.ready');
  const { pid } = (await widget(kiln, 'test-widget'))!;

  process.kill(pid!);

  const restarting = await events.next<KilnEvent<string, { attempt: number; delayMs: number }>>('widget.restarting');
  assert.equal(restarting.payload.attempt, 1);
  await events.next('widget.ready');
  const after = (await widget(kiln, 'test-widget'))!;
  assert.equal(after.state, 'ready');
  assert.equal(after.restarts, 1);
  assert.notEqual(after.pid, pid);
  assert.equal((await kiln.api<CoreStatus>('GET', '/api/status')).pid, core.pid);
});

test('a Widget that keeps crashing backs off, then is marked unhealthy', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t);
  const events = await kiln.events();

  await installAndApprove(kiln, source.path, { crash: true });

  const unhealthy = await events.next('widget.unhealthy', { timeoutMs: 10_000 });
  assert.equal((unhealthy.payload as { widgetId: string }).widgetId, 'test-widget');
  const delays: number[] = [];
  for (;;) {
    const next = await events.next<KilnEvent<string, { delayMs: number }>>('widget.restarting', { timeoutMs: 100 }).catch(() => undefined);
    if (!next) break;
    delays.push(next.payload.delayMs);
  }
  assert.ok(delays.length >= 2, 'it retried more than once');
  assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]!), `each wait is longer: ${delays.join(', ')}`);
  const info = (await widget(kiln, 'test-widget'))!;
  assert.equal(info.state, 'unhealthy');
  assert.match(info.problem ?? '', /code 3/);
  assert.equal((await kiln.api<CoreStatus>('GET', '/api/status')).name, 'Kiln');
});

test('an update that asks for nothing new swaps in; one with new needs waits for approval', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t);
  const events = await kiln.events();
  await installAndApprove(kiln, source.path);
  await events.next('widget.ready');

  source.setManifest({ version: '1.1.0' });
  const updated = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/update');
  assert.equal(updated.version, '1.1.0');
  assert.equal(updated.pin.commit, source.head());
  assert.equal(readLock(kiln).widgets['test-widget']?.commit, source.head());
  await events.next('widget.ready');
  const running = (await widget(kiln, 'test-widget'))!;
  assert.equal(running.state, 'ready');

  source.setManifest({ version: '1.2.0', needs: { network: ['api.example.com'] } });
  const asking = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/update');
  assert.equal(asking.version, '1.1.0', 'the old version keeps running');
  assert.equal(asking.pid, running.pid);
  assert.deepEqual(asking.pendingUpdate?.newNeeds, ['network: api.example.com']);
  assert.equal(asking.pendingUpdate?.manifest.version, '1.2.0');
  assert.notEqual(readLock(kiln).widgets['test-widget']?.commit, source.head(), 'not locked until approved');

  const approved = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/approve');
  assert.equal(approved.version, '1.2.0');
  assert.equal(approved.pendingUpdate, null);
  assert.deepEqual(approved.grants?.needs, { dataFolder: true, network: ['api.example.com'] });
  assert.equal(readLock(kiln).widgets['test-widget']?.commit, source.head());
  await events.next('widget.ready');
});

test('removing a Widget stops it and drops it from the lockfile', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t);
  const events = await kiln.events();
  await installAndApprove(kiln, source.path);
  await events.next('widget.ready');

  assert.equal((await kiln.request('DELETE', '/api/widgets/test-widget')).status, 200);

  await events.next('widget.removed');
  assert.equal(await widget(kiln, 'test-widget'), undefined);
  assert.equal(readLock(kiln).widgets['test-widget'], undefined);
  assert.equal((await kiln.request('DELETE', '/api/widgets/test-widget')).status, 404);
  const removals = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=widget.remove');
  assert.deepEqual(removals.map((e) => e.outcome).sort(), ['allowed', 'failed']);
});

test('install, update and remove leave the core and a running Session alone', async (t) => {
  const kiln = await startTestKiln(t);
  const core = await kiln.api<CoreStatus>('GET', '/api/status');
  const agent = await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const events = await kiln.events();
  const sessionId = await agent.startSession();
  const agentPid = (await widget(kiln, agent.widgetId))!.pid;

  const source = createWidgetSource(t);
  await installAndApprove(kiln, source.path);
  await events.next('widget.ready');
  source.setManifest({ version: '1.1.0' });
  await kiln.api('POST', '/api/widgets/test-widget/update');
  await events.next('widget.ready');
  await kiln.api('DELETE', '/api/widgets/test-widget');

  await agent.sendMessage(sessionId, { kind: 'text', text: 'still there?' });
  const heard = await events.next<KilnEvent<string, { text: string }>>('agent.progress');
  assert.equal(heard.payload.text, 'heard: still there?');
  assert.equal((await widget(kiln, agent.widgetId))!.pid, agentPid);
  assert.equal((await kiln.api<CoreStatus>('GET', '/api/status')).pid, core.pid);
});

test('a folder source runs in place, pinned to a hash, and will not start once it changes', async (t) => {
  const kiln = await startTestKiln(t);
  const source = createWidgetSource(t, { git: false });
  const events = await kiln.events();

  const installed = await kiln.api<WidgetInfo>('POST', '/api/widgets', { source: source.path });
  assert.equal(installed.pin.kind, 'folder');
  assert.match(installed.pin.hash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(readLock(kiln).widgets['test-widget']?.hash, installed.pin.hash);
  await kiln.api('POST', '/api/widgets/test-widget/approve');
  await events.next('widget.ready');
  await kiln.api('POST', '/api/widgets/test-widget/stop');

  source.setManifest({ version: '1.0.1' });
  const refused = await kiln.request<{ error: string }>('POST', '/api/widgets/test-widget/start');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /changed/);
  assert.match((await widget(kiln, 'test-widget'))?.problem ?? '', /changed/);

  const updated = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/update');
  assert.equal(updated.version, '1.0.1');
  assert.notEqual(updated.pin.hash, installed.pin.hash);
  assert.equal(updated.problem, null);
  assert.equal((await kiln.request('POST', '/api/widgets/test-widget/start')).status, 200);
  await events.next('widget.ready');
});

/** Has the test Widget make a core call with its own credential; resolves to the status it got. */
const widgetCall = async (kiln: TestKiln, method: string, path: string) => {
  const log = join(kiln.dataDir, 'widgets', 'test-widget', 'data', 'calls.jsonl');
  const before = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  await kiln.api('POST', '/api/test/widgets/test-widget/commands', { type: 'test.call', method, path });
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) {
    const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    if (lines.length > before) return (JSON.parse(lines[before]!) as { status: number }).status;
  }
  throw new Error(`The Widget did not report its ${method} ${path} call`);
};

test('a Widget call outside its grants is refused and audited', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const source = createWidgetSource(t, { manifest: { needs: { work: [{ access: 'read', projects: [project.id] }] } } });
  const events = await kiln.events();
  await installAndApprove(kiln, source.path);
  await events.next('widget.ready');

  assert.equal(await widgetCall(kiln, 'GET', `/api/items?project=${project.id}`), 200, 'inside the grant');
  assert.equal(await widgetCall(kiln, 'GET', '/api/items?project=other'), 403, 'another Project');
  assert.equal(await widgetCall(kiln, 'POST', `/api/projects/${project.id}/items`), 403, 'write needs a write grant');
  assert.equal(await widgetCall(kiln, 'GET', '/api/users'), 403, 'not a Work route');

  const refused = (await kiln.api<AuditEntry[]>('GET', '/api/audit')).filter(
    (e) => e.actor.kind === 'widget' && e.actor.id === 'test-widget' && e.outcome === 'refused',
  );
  assert.deepEqual(refused.map((e) => [e.method, e.path, e.reason]).sort(), [
    ['GET', '/api/items', 'grant'],
    ['GET', '/api/users', 'grant'],
    ['POST', `/api/projects/${project.id}/items`, 'grant'],
  ]);
});

test('a source the Org Policy does not allow is refused and audited', async (t) => {
  const kiln = await startTestKiln(t);
  const vetted = createWidgetSource(t, { manifest: { id: 'vetted' } });
  const other = createWidgetSource(t, { manifest: { id: 'other' } });
  await kiln.api('PUT', '/api/org-policy/widget-sources', { allowed: [vetted.path] });

  const refused = await kiln.request<{ reason: string }>('POST', '/api/widgets', { source: other.path });

  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'source');
  assert.equal((await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).length, 0);
  const [entry] = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=widget.install');
  assert.equal(entry?.outcome, 'refused');
  assert.equal((await kiln.request('POST', '/api/widgets', { source: vetted.path })).status, 201);
  assert.deepEqual(await kiln.api('GET', '/api/org-policy/widget-sources'), { allowed: [vetted.path] });
});

test("an Agent event for a Session another Widget runs is refused and audited, and the Session carries on", async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const repo = createFakeWidgetRepo(t);
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: repo.path, path: 'widgets/claude-code' });
  await kiln.api('POST', '/api/widgets/claude-code/approve');
  await events.next('widget.ready', { timeoutMs: 20_000 });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.equal(session?.agentId, 'fake');

  const log = join(kiln.dataDir, 'widgets', 'claude-code', 'data', 'calls.jsonl');
  const finished = { sessionId: session!.id, event: { kind: 'finished', reason: 'done' } };
  await kiln.api('POST', '/api/test/widgets/claude-code/commands', { type: 'test.call', method: 'POST', path: '/api/widget/agent-events', body: finished });
  let status: number | undefined;
  for (const deadline = Date.now() + 5000; status === undefined && Date.now() < deadline; await new Promise((r) => setTimeout(r, 20))) {
    const [line] = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    if (line) status = (JSON.parse(line) as { status: number }).status;
  }

  assert.equal(status, 403);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session!.id}`)).state, 'running');
  const refused = (await kiln.api<AuditEntry[]>('GET', '/api/audit')).filter(
    (e) => e.actor.kind === 'widget' && e.actor.id === 'claude-code' && e.outcome === 'refused',
  );
  assert.ok(refused.some((e) => e.target === `session:${session!.id}`), JSON.stringify(refused));
});
