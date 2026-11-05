// The demo Project on a dev instance (demo-project Ticket 05): `GET /api/demo` and
// `POST /api/demo/start {mode: 'live'}`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BudgetInfo, CoreStatus, DemoState, Item, Project, SessionInfo, SetupState, StartResult, WidgetInfo } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';

const ROLES = ['griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer'];

/** A Budget with the fake Agent's model, chosen for the given roles. */
async function chooseModels(kiln: TestKiln, roles = ROLES) {
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['fake-model'] });
  await kiln.api('PUT', '/api/setup', { roles: Object.fromEntries(roles.map((role) => [role, { model: 'fake-model' }])) });
}

const commits = (dir: string) =>
  execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');

const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..');
};

async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

test('Live on a dev core copies the template into the data folder, commits it once and registers it as "Demo"', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await chooseModels(kiln);

  const started = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'live' });

  const projects = await kiln.api<Project[]>('GET', '/api/projects');
  assert.equal(projects.length, 1);
  const demo = projects[0]!;
  assert.deepEqual(started, { available: true, mode: 'live', projectId: demo.id });
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), started);
  assert.equal(demo.name, 'Demo');
  assert.ok(isInside(kiln.dataDir, demo.path), `${demo.path} is inside the data folder`);
  assert.deepEqual(commits(demo.path), ['Demo project']);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: demo.path, encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: demo.path, encoding: 'utf8' }).trim(), 'main');
  assert.ok(existsSync(join(demo.path, '.scratch', 'slugify', 'story.md')));
  assert.equal(demo.workflowSource, 'default', 'Live writes no .kiln/workflow.json');
  assert.ok(!existsSync(join(demo.path, '.kiln', 'workflow.json')));
});

test('a live core refuses both demo routes and reports the demo unavailable', async (t) => {
  const kiln = await startTestKiln(t);
  await chooseModels(kiln);

  const state = await kiln.request<DemoState>('GET', '/api/demo');
  const start = await kiln.request<{ error: string }>('POST', '/api/demo/start', { mode: 'live' });

  assert.equal(state.status, 200);
  assert.deepEqual(state.body, { available: false });
  assert.equal(start.status, 409);
  assert.match(start.body.error, /dev instance/i);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
});

test('Live refuses with 409, naming every role that has no model; other modes are refused for now', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await chooseModels(kiln, ['implementer']);

  const refused = await kiln.request<{ error: string }>('POST', '/api/demo/start', { mode: 'live' });
  const unknown = await kiln.request<{ error: string }>('POST', '/api/demo/start', { mode: 'autoplay' });

  assert.equal(refused.status, 409);
  for (const role of ['griller', 'reviewer', 'spec-writer', 'ticket-writer']) assert.match(refused.body.error, new RegExp(role));
  assert.doesNotMatch(refused.body.error, /implementer/);
  assert.equal(unknown.status, 400);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), { available: true });
});

test('only an Admin may call the demo routes', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true, login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const mo = kiln.as('mo');

  assert.equal((await mo.request('GET', '/api/demo')).status, 403);
  assert.equal((await mo.request('POST', '/api/demo/start', { mode: 'live' })).status, 403);
});

test('starting twice leaves one fresh demo Project, nothing of the first run, and everything else untouched; a core restart keeps it', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await chooseModels(kiln);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const other = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path, name: 'Other' });
  const before = {
    budgets: (await kiln.api<BudgetInfo[]>('GET', '/api/budgets')).map((b) => [b.id, b.models]),
    widgets: (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).map((w) => [w.id, w.state]),
    settings: (await kiln.api<SetupState>('GET', '/api/setup')).settings,
  };

  const first = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'live' });
  const firstProject = (await kiln.api<Project[]>('GET', '/api/projects')).find((p) => p.id === first.projectId)!;
  const story = (await kiln.api<Item[]>('GET', `/api/projects/${first.projectId}/items`))[0]!;
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(story.id)}/start`);
  assert.ok(session?.worktree && existsSync(session.worktree));

  const second = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'live' });

  const projects = await kiln.api<Project[]>('GET', '/api/projects');
  const demos = projects.filter((p) => p.name === 'Demo');
  assert.equal(demos.length, 1);
  assert.notEqual(second.projectId, first.projectId);
  assert.equal(demos[0]!.id, second.projectId);
  assert.deepEqual(commits(demos[0]!.path), ['Demo project']);
  assert.ok(!existsSync(firstProject.path), "the first run's folder is gone");
  assert.ok(!existsSync(session.worktree), "the first run's worktree is gone");
  const sessions = await kiln.api<SessionInfo[]>('GET', '/api/sessions');
  assert.deepEqual(sessions.filter((s) => s.id === session.id), [], "the first run's Session is gone");
  assert.ok(projects.some((p) => p.id === other.id && p.name === 'Other'), 'the other Project stays');
  assert.deepEqual(
    {
      budgets: (await kiln.api<BudgetInfo[]>('GET', '/api/budgets')).map((b) => [b.id, b.models]),
      widgets: (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).map((w) => [w.id, w.state]),
      settings: (await kiln.api<SetupState>('GET', '/api/setup')).settings,
    },
    before,
  );

  const pid = (await kiln.api<CoreStatus>('GET', '/api/status')).pid;
  await kiln.api('POST', '/api/core/restart-when-idle');
  await eventually('the restarted core', async () => {
    const status = await kiln.api<CoreStatus>('GET', '/api/status');
    return status.pid !== pid ? status : undefined;
  });
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), second);
});
