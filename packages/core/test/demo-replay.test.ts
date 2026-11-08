// Replay (demo-project Ticket 06): `POST /api/demo/start {mode: 'replay'}` routes every role of the
// demo Project to the fake Agent, which plays the whole Story from `packages/demo/replay/scripts.json`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Ask,
  AskRaisedEvent,
  BudgetInfo,
  DemoState,
  Item,
  Project,
  SessionInfo,
  StartResult,
  UsageRecord,
  WidgetInfo,
  Workflow,
} from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';

const ROLES = ['griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer'];
const STORY = 'Add `slugify(title)`';

type Events = Awaited<ReturnType<TestKiln['events']>>;

/** The wizard's choices: every role on a model of a Budget. Replay must use neither. */
async function chooseWizardModels(kiln: TestKiln) {
  await kiln.api('PUT', '/api/budgets/claude-max', { kind: 'subscription', models: ['wizard-model'] });
  await kiln.api('PUT', '/api/setup', { roles: Object.fromEntries(ROLES.map((role) => [role, { model: 'wizard-model' }])) });
}

async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const fakeAgent = async (kiln: TestKiln) =>
  (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).filter((w) => w.id === 'fake-agent');

const nextAsk = async (events: Events, accept: (ask: Ask) => boolean): Promise<Ask> => {
  for (;;) {
    const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 180_000 })).payload;
    if (accept(ask)) return ask;
  }
};

const answer = async (kiln: TestKiln, ask: Ask, text: string) =>
  assert.equal((await kiln.request('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: text })).status, 200);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('Replay plays the demo Story to shipped on the fake Agent, with the wizard models and their Budget untouched', { timeout: 300_000 }, async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await chooseWizardModels(kiln);
  const events = await kiln.events();

  const started = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });
  assert.equal(started.mode, 'replay');
  const project = (await kiln.api<Project[]>('GET', '/api/projects')).find((p) => p.id === started.projectId)!;
  assert.equal(project.workflowSource, 'file');
  const workflow = JSON.parse(git(project.path, 'show', 'main:.kiln/workflow.json')) as Workflow;
  assert.equal(workflow.name, 'demo-replay');
  const roleStages = workflow.kinds.flatMap((k) => k.stages).filter((s) => s.role);
  assert.deepEqual([...new Set(roleStages.map((s) => s.role))].sort(), ROLES);
  for (const stage of roleStages) assert.deepEqual([stage.agent, stage.model], ['fake', 'fake-model'], stage.id);
  await eventually('the fake Agent to be ready', async () => ((await fakeAgent(kiln))[0]?.state === 'ready' ? true : undefined));

  // The person starts the Story and answers both grill Asks.
  const story = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === STORY)!;
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(story.id)}/start`);
  const grillAsks: Ask[] = [];
  for (let n = 0; n < 2; n++) {
    const ask = await nextAsk(events, (a) => a.itemId === story.id && a.type !== 'review');
    assert.equal(ask.blocking, true);
    grillAsks.push(ask);
    await answer(kiln, ask, ask.recommendation);
  }
  assert.match(grillAsks[0]!.question, /accented/i);
  assert.match(grillAsks[1]!.question, /empty result/i);

  // The Spec and Tickets Gates.
  for (const stage of ['spec', 'tickets']) {
    const gate = await nextAsk(events, (a) => a.itemId === story.id && a.type === 'review');
    assert.equal(gate.raisedBy.kind === 'gate' && gate.raisedBy.stage, stage);
    await answer(kiln, gate, 'Approve');
  }

  // Ticket 02 is Blocked by 01, so it starts only after 01 ships. The person approves 01's Review,
  // waits for it to ship, then does the same for 02.
  const ticketIds = [`${project.id}/ticket/slugify/01`, `${project.id}/ticket/slugify/02`];
  const shipped = (id: string) =>
    eventually(`${id} to ship`, async () => {
      const now = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === id);
      return now?.stage === 'shipped' ? now : undefined;
    });
  for (const id of ticketIds) {
    const review = await nextAsk(events, (a) => a.type === 'review' && a.itemId === id);
    assert.match(review.review!.findings, /No problems found; scripted review/);
    await answer(kiln, review, 'Approve');
    await shipped(id);
  }
  await shipped(story.id);
  const board = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  for (const id of [story.id, ...ticketIds]) assert.equal(board.find((i) => i.id === id)?.runState, 'shipped', id);

  // main holds both Tickets' code, and its tests pass.
  assert.equal(git(project.path, 'branch', '--show-current').trim(), 'main');
  // The Tracker commits the Story's `stage: shipped` line just after the board shows it shipped.
  await eventually('main to be committed', async () => (git(project.path, 'status', '--porcelain') === '' ? true : undefined), 10_000);
  for (const file of ['src/slugify.js', 'src/cli.js', 'test/slugify.test.js', 'test/cli.test.js']) git(project.path, 'cat-file', '-e', `main:${file}`);
  assert.match(git(project.path, 'show', 'main:.scratch/slugify/grill.md'), /Replay/);
  assert.match(git(project.path, 'show', 'main:.scratch/slugify/issues/02-slugify-cli.md'), /\*\*Blocked by:\*\* 01/);
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--test'], { cwd: project.path, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(readFileSync(join(project.path, 'src', 'cli.js'), 'utf8'), /\.\/slugify\.js/);

  // Every Session ran on the fake Agent. Its turns are recorded under Replay's own Budget at no
  // cost, and the wizard's Budget is never drawn on.
  const sessions = (await kiln.api<SessionInfo[]>('GET', '/api/sessions')).filter((s) => s.projectId === project.id);
  assert.deepEqual([...new Set(sessions.map((s) => s.role))].sort(), ROLES);
  for (const session of sessions) assert.deepEqual([session.agentId, session.model], ['fake', 'fake-model'], session.role);
  const usage = await kiln.api<UsageRecord[]>('GET', '/api/usage/records');
  assert.ok(usage.length >= sessions.length, 'every Session reported usage');
  for (const record of usage) {
    assert.deepEqual([record.projectId, record.model, record.budgetId, record.cost], [project.id, 'fake-model', 'replay', null]);
  }
  const budgets = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.deepEqual(budgets.map((b) => [b.id, b.kind, b.models]).sort(), [
    ['claude-max', 'subscription', ['wizard-model']],
    ['replay', 'metered', ['fake-model']],
  ]);
  for (const budget of budgets) assert.equal(budget.gauge.used, 0, `${budget.id} drew nothing`);
});

test('a Replay start reuses a fake Agent that is already installed', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  await kiln.installFakeAgent();
  const [before] = await fakeAgent(kiln);

  await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });

  const after = await fakeAgent(kiln);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0]!.state, after[0]!.pid, after[0]!.pin], [before!.state, before!.pid, before!.pin]);
});

test('Replay installs the fake Agent once, and a second start reuses it', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });

  await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });
  const [first] = await eventually('the fake Agent to be ready', async () => {
    const found = await fakeAgent(kiln);
    return found[0]?.state === 'ready' ? found : undefined;
  });
  assert.ok(first!.grants, 'approved as part of the Demo step');
  await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });

  const after = await fakeAgent(kiln);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0]!.state, after[0]!.pid], ['ready', first!.pid]);
});

test('a Widget source policy that refuses the fake Agent fails Replay with its message, and is left as it was', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  const policy = { allowed: ['https://github.com/kiln-widgets/*'] };
  await kiln.api('PUT', '/api/org-policy/widget-sources', policy);

  const refused = await kiln.request<{ error: string }>('POST', '/api/demo/start', { mode: 'replay' });

  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Org Policy does not allow installing from .*fake-agent/);
  assert.deepEqual(await kiln.api('GET', '/api/org-policy/widget-sources'), policy);
  assert.deepEqual(await fakeAgent(kiln), []);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), { available: true });
});
