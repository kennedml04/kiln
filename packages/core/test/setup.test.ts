import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OLD_BOARD_DATA_FOLDER, type BudgetInfo, type DemoState, type DoctorReport, type ImportResult, type Item, type Project, type SetupState, type StartResult } from '@kiln/widget-sdk';
import { createTempRepo, onCleanup, startTestKiln, tempDir } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;

/** A fake OpenAI-compatible local model server (Ollama, LM Studio, llama.cpp all answer /v1/models). */
async function fakeModelServer(t: Parameters<typeof onCleanup>[0], models: string[]): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(t, 'stop the fake model server', () => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

/** Every file under `root` with its size, mtime and content hash: equal snapshots mean nothing was written. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(root, { recursive: true }).map(String)) {
    const path = join(root, name);
    const stat = statSync(path);
    files[name] = stat.isDirectory()
      ? `dir ${stat.mtimeMs}`
      : `${stat.size} ${stat.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }
  return files;
}

test('a fresh data folder has not been set up', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(state.completed, false);
});

test('a work install starts with a metered Budget of 10,000 credits a month, and its limits can be changed', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });

  const state = await kiln.api<SetupState>('PUT', '/api/setup', { install: 'work' });
  assert.equal(state.settings.install, 'work');
  assert.deepEqual(state.defaults.work.map((b) => [b.kind, b.monthly]), [['metered', 10_000]]);

  const draft = state.defaults.work[0]!;
  await kiln.api('PUT', `/api/budgets/${draft.id}`, { ...withoutId(draft), monthly: 4_000, models: ['work-model'] });
  const budgets = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.deepEqual(budgets.map((b) => [b.id, b.kind, b.models]), [[draft.id, 'metered', ['work-model']]]);
  assert.equal(budgets[0]!.limits.find((l) => l.id === 'month')?.cap, 4_000);
});

test('a home install offers a Claude Max subscription Budget, plus a local Budget only when a local model server is found', async (t) => {
  const none = await startTestKiln(t, { setup: 'fresh' });
  const withoutServer = await none.api<SetupState>('GET', '/api/setup');
  assert.equal(withoutServer.localModelServer.found, false);
  assert.deepEqual(withoutServer.defaults.home.map((b) => b.kind), ['subscription']);
  assert.equal(withoutServer.defaults.home[0]!.name, 'Claude Max');

  const url = await fakeModelServer(t, ['qwen3-coder', 'gpt-oss-20b']);
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_LOCAL_MODEL_URLS: url } });
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(state.localModelServer, { found: true, url, models: ['qwen3-coder', 'gpt-oss-20b'] });
  assert.deepEqual(
    state.defaults.home.map((b) => [b.kind, b.models]),
    [
      ['subscription', []],
      ['local', ['qwen3-coder', 'gpt-oss-20b']],
    ],
  );
});

test('Obsidian is only suggested: setup finishes without it', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(state.obsidian.installed, false);
  assert.match(state.obsidian.suggestion!, /optional/);

  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['max-model'] });
  await kiln.api('PUT', '/api/setup', { roles: Object.fromEntries(state.roles.map((r) => [r.role, { model: 'max-model' }])) });
  const done = await kiln.api<SetupState>('POST', '/api/setup/complete');
  assert.equal(done.completed, true);
});

test('setup finds Obsidian when it is installed, and sees a vault in the Knowledge store folder', async (t) => {
  const apps = tempDir(t, 'kiln-apps');
  writeFileSync(join(apps, 'Obsidian.exe'), '');
  const vault = tempDir(t, 'kiln-vault');
  mkdirSync(join(vault, '.obsidian'));
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_OBSIDIAN_PATHS: join(apps, 'Obsidian.exe') } });

  const state = await kiln.api<SetupState>('PUT', '/api/setup', { knowledgeDir: vault });

  assert.equal(state.obsidian.installed, true);
  assert.equal(state.obsidian.suggestion, undefined);
  assert.equal(state.obsidian.vault, true);
  assert.equal(state.running.knowledgeDir, vault);
  const doctor = await kiln.api<DoctorReport>('GET', '/api/doctor');
  assert.match(doctor.checks.find((c) => c.id === 'knowledge-store')!.detail, new RegExp(vault.replace(/\\/g, '\\\\')));
});

test('setup cannot finish until there is a Budget and every default Workflow role has a model', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(state.roles.map((r) => r.role).sort(), ['chat', 'griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer']);

  const early = await kiln.request<{ error: string }>('POST', '/api/setup/complete');
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Budget/);
  assert.match(early.body.error, /implementer/);

  // No silent default: a model has to be chosen, and it must belong to a Budget.
  const unknown = await kiln.request<{ error: string }>('PUT', '/api/setup', { roles: { implementer: { model: 'nowhere-model' } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /No Budget/);

  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model', 'small-model'] });
  await kiln.api('PUT', '/api/setup', { roles: { implementer: { model: 'big-model', fallbackModel: 'small-model' } } });
  const half = await kiln.request<{ error: string }>('POST', '/api/setup/complete');
  assert.equal(half.status, 409);
  assert.doesNotMatch(half.body.error, /implementer/);
  assert.match(half.body.error, /reviewer/);

  await kiln.api('PUT', '/api/setup', {
    roles: { chat: { model: 'small-model' }, reviewer: { model: 'small-model' }, griller: { model: 'big-model' }, 'spec-writer': { model: 'big-model' }, 'ticket-writer': { model: 'big-model' } },
  });
  const done = await kiln.api<SetupState>('POST', '/api/setup/complete');
  assert.equal(done.completed, true);
  const doctor = await kiln.api<DoctorReport>('GET', '/api/doctor');
  assert.equal(doctor.checks.find((c) => c.id === 'setup')!.status, 'pass');
});

/** Every default Workflow role on a model of a Budget, as the wizard's Workflow roles step saves them. */
async function chooseEveryRole(kiln: Awaited<ReturnType<typeof startTestKiln>>) {
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model'] });
  const roles = ['chat', 'griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer'];
  await kiln.api('PUT', '/api/setup', { roles: Object.fromEntries(roles.map((role) => [role, { model: 'big-model' }])) });
}

test('on a dev instance whose demo is Replay, Finish needs no role models, and no Agent or Budget set up by hand', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  assert.equal((await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' })).mode, 'replay');

  const done = await kiln.api<SetupState>('POST', '/api/setup/complete');
  assert.equal(done.completed, true);
  assert.equal(done.settings.roles, undefined, 'no role was given a model');
});

test('on a dev instance whose demo is Replay, Finish also takes role models', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  await chooseEveryRole(kiln);
  await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });

  assert.equal((await kiln.api<SetupState>('POST', '/api/setup/complete')).completed, true);
});

test('on a dev instance with no demo, or a Live one, Finish still needs a model for every role', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model'] });
  // Skip: no demo started.
  const skipped = await kiln.request<{ error: string }>('POST', '/api/setup/complete');
  assert.equal(skipped.status, 409);
  assert.match(skipped.body.error, /Choose a model for the implementer role/);
  // Live refuses while a role has no model, so Finish is still refused.
  const live = await kiln.request<{ error: string }>('POST', '/api/demo/start', { mode: 'live' });
  assert.equal(live.status, 409);
  assert.match(live.body.error, /the implementer role/);
  assert.equal((await kiln.request('POST', '/api/setup/complete')).status, 409);

  await chooseEveryRole(kiln);
  assert.equal((await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'live' })).mode, 'live');
  assert.equal((await kiln.api<SetupState>('POST', '/api/setup/complete')).completed, true);
});

test('a live instance needs a model for every role to finish, with or without one set', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model'] });
  const without = await kiln.request<{ error: string }>('POST', '/api/setup/complete');
  assert.equal(without.status, 409);
  assert.match(without.body.error, /Choose a model for the griller role/);

  await chooseEveryRole(kiln);
  assert.equal((await kiln.api<SetupState>('POST', '/api/setup/complete')).completed, true);
});

test("the models chosen for the default Workflow's roles are the ones its Stages run on", async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model', 'small-model'] });
  await kiln.api('PUT', '/api/setup', {
    roles: { implementer: { model: 'big-model', fallbackModel: 'small-model' }, reviewer: { model: 'small-model' } },
  });

  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });

  const ticket = project.workflow.kinds.find((k) => k.id === 'ticket')!;
  const stage = (id: string) => ticket.stages.find((s) => s.id === id)!;
  assert.deepEqual([stage('implementing').model, stage('implementing').fallbackModel], ['big-model', 'small-model']);
  assert.equal(stage('review').model, 'small-model');
});

test('a Stage runs on an Agent that lists its model, even when the Agent names no default model', async (t) => {
  // The real Agent Widgets list the models they run and name no single default one.
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  await kiln.installFakeAgent({ model: null, models: ['big-model', 'small-model'] });
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model', 'small-model'] });
  await kiln.api('PUT', '/api/setup', { roles: { implementer: { model: 'small-model' } } });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;

  const started = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);

  assert.deepEqual([started.session?.agentId, started.session?.model], ['fake', 'small-model']);
});

test('choosing Tailscale login notes that tailscale serve works, and takes effect when Kiln restarts', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });

  const state = await kiln.api<SetupState>('PUT', '/api/setup', { login: 'tailscale' });

  assert.equal(state.settings.login, 'tailscale');
  assert.equal(state.running.login, 'local');
  assert.equal(state.restartNeeded, true);
  assert.match(state.tailscale.note, /tailscale serve/);
  assert.match(state.tailscale.note, /Funnel/);
  assert.equal(state.tailscale.servesKiln, undefined);
});

test('setup reports what tailscale serve forwards to Kiln, and how', async (t) => {
  const fakeTailscale = join(tempDir(t, 'kiln-fake-tailscale'), 'tailscale.mjs');
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_TAILSCALE_CLI: fakeTailscale } });
  const serve = { TCP: { '8443': { TCPForward: `127.0.0.1:${kiln.port}` } }, AllowFunnel: { 'pc.example.ts.net:8443': true } };
  writeFileSync(fakeTailscale, `console.log(${JSON.stringify(JSON.stringify(serve))});\n`);

  const state = await kiln.api<SetupState>('GET', '/api/setup');

  assert.deepEqual(state.tailscale.servesKiln, { target: `127.0.0.1:${kiln.port}`, kind: 'tcp', funnel: true });
});

test('kiln doctor passes with no proxy in Tailscale mode, and no longer warns people off tailscale serve', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const doctor = await kiln.api<DoctorReport>('GET', '/api/doctor');
  const proxy = doctor.checks.find((c) => c.id === 'proxy')!;
  assert.equal(proxy.status, 'pass');
  assert.equal(proxy.detail, 'No reverse proxy found in front of Kiln.');
});

test("importing from the old board registers its Projects with their .scratch Items, and never writes to the old board's folder", async (t) => {
  // A copy of the old board's layout: its folder, its data folder and its Project registry.
  const board = tempDir(t, 'kiln-old-board-copy');
  mkdirSync(join(board, OLD_BOARD_DATA_FOLDER));
  writeFileSync(join(board, OLD_BOARD_DATA_FOLDER, 'state.json'), '{"cards":[]}\n');
  writeFileSync(join(board, 'server.py'), 'print("old board")\n');
  const alpha = createTempRepo(t);
  seedScratch(alpha);
  const beta = createTempRepo(t);
  const registry = join(board, OLD_BOARD_DATA_FOLDER, 'projects.json');
  writeFileSync(
    registry,
    JSON.stringify({
      projects: [
        { name: 'alpha', path: alpha.path, private: false, shipped: false, story_board: true },
        { name: 'beta', path: beta.path, private: true, shipped: false, story_board: false },
        { name: 'old-board', path: board, private: false, shipped: false, story_board: true },
        { name: 'wsl-only', path: join(board, '..', 'kiln-test-not-on-this-pc'), private: false, shipped: false, story_board: false },
      ],
    }),
  );
  const before = snapshot(board);
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_OLD_BOARD_REGISTRY: registry } });

  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(state.oldBoard.found, true);
  assert.deepEqual(
    state.oldBoard.projects.map((p) => [p.name, p.skip ?? null]),
    [
      ['alpha', null],
      ['beta', null],
      ['old-board', "the old board's own folder"],
      ['wsl-only', 'the folder is not on this PC'],
    ],
  );

  const result = await kiln.api<ImportResult>('POST', '/api/setup/import', {});

  assert.deepEqual(result.imported.map((p) => p.name), ['alpha', 'beta']);
  assert.deepEqual(result.skipped.map((s) => s.name), ['old-board', 'wsl-only']);
  const projects = await kiln.api<Project[]>('GET', '/api/projects');
  assert.deepEqual(projects.map((p) => p.name).sort(), ['alpha', 'beta']);
  const items = await kiln.api<Item[]>('GET', `/api/projects/${result.imported[0]!.id}/items`);
  assert.deepEqual(items.map((i) => i.title).sort(), ['Board as home', 'Draw the columns', 'Home board', 'Live updates']);

  // Importing again skips what is already registered.
  const again = await kiln.api<ImportResult>('POST', '/api/setup/import', {});
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.skipped.filter((s) => s.reason === 'already registered').map((s) => s.name), ['alpha', 'beta']);

  assert.deepEqual(snapshot(board), before);
});

test('with no old board named, Kiln looks nowhere and imports nothing; naming its projects.json in the settings finds its Projects', async (t) => {
  const board = tempDir(t, 'kiln-old-board-copy');
  mkdirSync(join(board, OLD_BOARD_DATA_FOLDER));
  const alpha = createTempRepo(t);
  const registry = join(board, OLD_BOARD_DATA_FOLDER, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ name: 'alpha', path: alpha.path }] }));
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_OLD_BOARD_REGISTRY: '' } });

  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(state.oldBoard, { found: false, projects: [] });
  const refused = await kiln.request<{ error: string }>('POST', '/api/setup/import', {});
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'No old board is set: give the path of its projects.json');

  await kiln.api('PUT', '/api/setup', { oldBoardRegistry: registry });
  const named = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(named.oldBoard.registry, registry);
  assert.deepEqual(named.oldBoard.projects.map((p) => p.name), ['alpha']);
});

test("a dev instance does not offer or import the old board's real Projects, but a Project can still be added by hand", async (t) => {
  const board = tempDir(t, 'kiln-old-board-copy');
  mkdirSync(join(board, OLD_BOARD_DATA_FOLDER));
  const alpha = createTempRepo(t);
  const registry = join(board, OLD_BOARD_DATA_FOLDER, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ name: 'alpha', path: alpha.path }] }));
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true, env: { KILN_OLD_BOARD_REGISTRY: registry } });
  assert.equal((await kiln.api<{ instance: string }>('GET', '/api/status')).instance, 'dev');

  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(state.oldBoard.projects, []);

  const refused = await kiln.request<{ error: string }>('POST', '/api/setup/import', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "Dev instances don't import real Projects; add one by hand if you mean to");
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path, name: 'by hand' });
  assert.deepEqual((await kiln.api<Project[]>('GET', '/api/projects')).map((p) => p.id), [project.id]);
});

test('setup is Admin work', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', login: 'tailscale' });
  await kiln.api('PUT', '/api/users/sam@example.com', { role: 'member' });
  const member = kiln.as('sam@example.com');

  assert.equal((await member.request('GET', '/api/setup')).status, 403);
  assert.equal((await member.request('PUT', '/api/setup', { install: 'home' })).status, 403);
  assert.equal((await member.request('POST', '/api/setup/import', {})).status, 403);
});

test('the chat role is a Kiln role beside the Workflow roles, and takes a model like any other', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  assert.ok(state.roles.some((r) => r.role === 'chat'));
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['big-model', 'small-model'] });
  await kiln.api('PUT', '/api/setup', { roles: { chat: { model: 'small-model' } } });
  const after = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(after.settings.roles?.chat?.model, 'small-model');
});
