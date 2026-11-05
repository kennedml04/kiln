import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OLD_BOARD_DATA_FOLDER, type BudgetInfo, type DemoState, type Project, type SetupState, type WidgetInfo } from '@kiln/widget-sdk';
import { createFakeWidgetRepo, createTempRepo, createWidgetRepoCopy, startTestKiln, tempDir } from '@kiln/testing';
import type { Locator } from 'playwright';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

/** A copy of the old board's Project registry, listing one Project. */
function oldBoardCopy(t: Parameters<typeof tempDir>[0]): { registry: string } {
  const board = tempDir(t, 'kiln-old-board-copy');
  mkdirSync(join(board, OLD_BOARD_DATA_FOLDER));
  const alpha = createTempRepo(t);
  seedScratch(alpha);
  const registry = join(board, OLD_BOARD_DATA_FOLDER, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ name: 'alpha', path: alpha.path, private: false, shipped: false, story_board: true }] }));
  return { registry };
}

test('a fresh data folder opens the setup wizard, and finishing it leaves Budgets, Agents and role models set', async (t) => {
  const widgetRepo = createFakeWidgetRepo(t);
  const { registry } = oldBoardCopy(t);
  // No old board named: Kiln has no default place to look, so the Import step asks for it.
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_OLD_BOARD_REGISTRY: '' } });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  const next = () => wizard.getByRole('button', { name: 'Next' }).click();
  const step = (name: string) => wizard.getByRole('heading', { name, level: 3 }).waitFor();

  // Login mode: Tailscale notes that tailscale serve works in front of Kiln.
  await step('Login');
  await wizard.getByRole('radio', { name: /Tailscale/ }).check();
  await wizard.getByRole('note').filter({ hasText: 'tailscale serve' }).waitFor();
  await wizard.getByRole('radio', { name: /Local/ }).check();
  await next();

  // The Knowledge store: Obsidian is suggested, never required.
  await step('Knowledge store');
  await wizard.getByText(/Obsidian is not installed\. It is optional/).waitFor();
  await next();

  // Work install: one metered Budget, its limits editable.
  await step('Install');
  await wizard.getByRole('radio', { name: /Work/ }).check();
  const credits = wizard.getByRole('group', { name: 'Work credits' });
  assert.equal(await credits.getByLabel('Credits per month').inputValue(), '10000');
  await credits.getByLabel('Credits per month').fill('8000');
  await next();

  // First-party Agent Widgets, from the Widget repo.
  await step('Agents');
  await wizard.getByLabel('Widget repo').fill(widgetRepo.path);
  assert.equal(await wizard.getByRole('checkbox', { name: /Claude Code/ }).isChecked(), true);
  await wizard.getByRole('button', { name: 'Install Agents' }).click();
  await wizard.getByText('Claude Code: ready').waitFor({ timeout: 20_000 });
  await next();

  // Which models belong to which Budget.
  await step('Models');
  // The Agent's models are listed by name, already in the install's Budget.
  await wizard.getByText('A Budget is what pays for a model').waitFor();
  const claude = wizard.getByRole('listitem', { name: 'Claude Test' });
  await claude.getByText('claude-test-model').waitFor();
  await claude.getByText('Claude Code').waitFor();
  assert.equal(await wizard.getByLabel('Budget for claude-test-model').inputValue(), 'work-credits');
  // One no Agent reports is added by hand, with a reminder to type its exact ID.
  await wizard.getByLabel('Add a model').fill('cheap-test-model');
  await wizard.getByRole('button', { name: 'Add', exact: true }).click();
  const cheap = wizard.getByRole('listitem', { name: 'cheap-test-model' });
  await cheap.getByText('Check it is the exact ID the Agent reports.').waitFor();
  assert.equal(await wizard.getByLabel('Budget for cheap-test-model').inputValue(), 'work-credits');
  // None leaves a model out of every Budget.
  await wizard.getByLabel('Budget for cheap-test-model').selectOption('');
  await wizard.getByLabel('Budget for cheap-test-model').selectOption('work-credits');
  await next();

  // Every default Workflow role opens with a suggested model, said so, and each can be changed.
  await step('Workflow roles');
  await wizard.getByText(/Suggested from your Budgets/).waitFor();
  assert.equal(await wizard.getByLabel('implementer model', { exact: true }).inputValue(), 'claude-test-model');
  assert.equal(await wizard.getByRole('button', { name: 'Next' }).isDisabled(), false);
  await wizard.getByLabel('implementer model', { exact: true }).selectOption('claude-test-model');
  await wizard.getByLabel('implementer fallback', { exact: true }).selectOption('cheap-test-model');
  await wizard.getByLabel('reviewer model', { exact: true }).selectOption('cheap-test-model');
  for (const role of ['griller', 'spec-writer', 'ticket-writer']) {
    await wizard.getByLabel(`${role} model`, { exact: true }).selectOption('claude-test-model');
  }
  await next();

  // The one-time import from the old board.
  await step('Import');
  await wizard.getByText('No old board named. Nothing to import; this step can be skipped.').waitFor();
  await wizard.getByLabel("The old board's projects.json").fill(registry);
  await wizard.getByRole('button', { name: 'Look' }).click();
  await wizard.getByRole('checkbox', { name: /alpha/ }).waitFor();
  assert.equal(await wizard.getByRole('checkbox', { name: /alpha/ }).isChecked(), true);
  await wizard.getByRole('button', { name: 'Import Projects' }).click();
  await wizard.getByText('Imported alpha').waitFor();
  await wizard.getByRole('button', { name: 'Finish' }).click();

  await page.waitForURL(`${kiln.url}/`);
  await page.getByRole('link', { name: 'alpha' }).first().waitFor();

  const setup = await kiln.api<SetupState>('GET', '/api/setup');
  assert.equal(setup.completed, true);
  const budgets = await kiln.api<BudgetInfo[]>('GET', '/api/budgets');
  assert.deepEqual(budgets.map((b) => [b.kind, b.name, b.models]), [['metered', 'Work credits', ['claude-test-model', 'cheap-test-model']]]);
  assert.equal(budgets[0]!.limits.find((l) => l.id === 'month')?.cap, 8_000);
  const widgets = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  assert.deepEqual(widgets.filter((w) => w.state === 'ready').map((w) => [w.id, w.agents.map((a) => a.id)]), [['claude-code', ['claude']]]);
  const [alpha] = await kiln.api<Project[]>('GET', '/api/projects');
  const implementing = alpha!.workflow.kinds.find((k) => k.id === 'ticket')!.stages.find((s) => s.id === 'implementing')!;
  assert.deepEqual([implementing.model, implementing.fallbackModel], ['claude-test-model', 'cheap-test-model']);
  // Each role is saved with the Agent whose model draws from the chosen model's Budget.
  const review = alpha!.workflow.kinds.find((k) => k.id === 'ticket')!.stages.find((s) => s.id === 'review')!;
  assert.deepEqual([implementing.agent, review.model, review.agent], ['claude', 'cheap-test-model', 'claude']);

  // Once finished, the Shell opens on the board, and an Admin can run setup again from Settings.
  await page.goto(`${kiln.url}/`);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Run setup again' }).click();
  await page.getByRole('region', { name: 'Set up Kiln' }).waitFor();
});

test('the roles step suggests the strongest model for planning and review, a mid one for implementing, each with a lighter fallback', async (t) => {
  const widgetRepo = createFakeWidgetRepo(t, [
    {
      id: 'claude-code',
      name: 'Claude Code',
      agent: {
        id: 'claude',
        name: 'Claude Code',
        model: 'claude-sonnet-test',
        models: [
          { id: 'claude-haiku-test', name: 'Haiku Test' },
          { id: 'claude-sonnet-test', name: 'Sonnet Test' },
          { id: 'claude-opus-test', name: 'Opus Test' },
        ],
      },
    },
  ]);
  const kiln = await startTestKiln(t, { setup: 'fresh' });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  const step = (name: string) => wizard.getByRole('heading', { name, level: 3 }).waitFor();
  const next = () => wizard.getByRole('button', { name: 'Next' }).click();
  for (const name of ['Login', 'Knowledge store', 'Install']) {
    await step(name);
    if (name === 'Install') await wizard.getByRole('radio', { name: /Work/ }).check();
    await next();
  }
  await step('Agents');
  await wizard.getByLabel('Widget repo').fill(widgetRepo.path);
  await wizard.getByRole('button', { name: 'Install Agents' }).click();
  await wizard.getByText('Claude Code: ready').waitFor({ timeout: 20_000 });
  await next();
  await step('Models');
  await wizard.getByLabel('Budget for claude-opus-test').waitFor();
  await next();

  await step('Workflow roles');
  const chosen = async (role: string) => [
    await wizard.getByLabel(`${role} model`, { exact: true }).inputValue(),
    await wizard.getByLabel(`${role} fallback`, { exact: true }).inputValue(),
  ];
  for (const role of ['griller', 'spec-writer', 'reviewer']) assert.deepEqual(await chosen(role), ['claude-opus-test', 'claude-sonnet-test'], role);
  for (const role of ['implementer', 'ticket-writer']) assert.deepEqual(await chosen(role), ['claude-sonnet-test', 'claude-haiku-test'], role);

  // A change stays when the step is left and opened again.
  await wizard.getByLabel('reviewer model', { exact: true }).selectOption('claude-haiku-test');
  await next();
  await step('Import');
  await wizard.getByRole('button', { name: 'Back' }).click();
  await step('Workflow roles');
  assert.equal(await wizard.getByLabel('reviewer model', { exact: true }).inputValue(), 'claude-haiku-test');
  const setup = await kiln.api<SetupState>('GET', '/api/setup');
  assert.deepEqual(setup.settings.roles?.implementer && [setup.settings.roles.implementer.model, setup.settings.roles.implementer.fallbackModel], ['claude-sonnet-test', 'claude-haiku-test']);
});

test("the Agents step installs the real first-party Agent Widgets from a clone of this repo, and each reaches ready", async (t) => {
  const widgetRepo = createWidgetRepoCopy(t);
  // npm installs Claude Code's packages from its cache only: a test never needs the network.
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { npm_config_offline: 'true' } });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  const step = (name: string) => wizard.getByRole('heading', { name, level: 3 }).waitFor();
  for (const name of ['Login', 'Knowledge store', 'Install']) {
    await step(name);
    if (name === 'Install') await wizard.getByRole('radio', { name: /Home/ }).check();
    await wizard.getByRole('button', { name: 'Next' }).click();
  }

  await step('Agents');
  await wizard.getByLabel('Widget repo').fill(widgetRepo.path);
  for (const name of ['Claude Code', 'OpenCode']) await wizard.getByRole('checkbox', { name: new RegExp(name) }).check();
  await wizard.getByRole('button', { name: 'Install Agents' }).click();
  await wizard.getByText('Claude Code: ready').waitFor({ timeout: 90_000 });
  await wizard.getByText('OpenCode: ready').waitFor({ timeout: 30_000 });

  const widgets = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  assert.deepEqual(widgets.map((w) => [w.id, w.state, w.pin.kind]).sort(), [['claude-code', 'ready', 'git'], ['opencode', 'ready', 'git']]);
});

/** Starts a fresh core whose fake `tailscale` reports `serve(port)` as its serve config. */
async function withServe(t: Parameters<typeof tempDir>[0], serve: (port: number) => unknown) {
  const fakeTailscale = join(tempDir(t, 'kiln-fake-tailscale'), 'tailscale.mjs');
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_TAILSCALE_CLI: fakeTailscale } });
  writeFileSync(fakeTailscale, `console.log(${JSON.stringify(JSON.stringify(serve(kiln.port)))});\n`);
  return kiln;
}

test('the wizard lets tailscale serve be, but stops on a raw TCP forward that would make every caller Admin', async (t) => {
  const web = await withServe(t, (port) => ({ Web: { 'pc.example.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } }));
  const page = await openShell(t, web, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  await wizard.getByRole('heading', { name: 'Login', level: 3 }).waitFor();
  await wizard.getByText(/In Local mode its callers get no access/).waitFor();
  await wizard.getByRole('radio', { name: /Tailscale/ }).check();
  await wizard.getByRole('note').filter({ hasText: 'tailscale serve' }).waitFor();
  assert.equal(await wizard.getByText(/In Local mode its callers get no access/).count(), 0);
  assert.equal(await wizard.getByRole('alert').count(), 0);

  const tcp = await withServe(t, (port) => ({ TCP: { '8443': { TCPForward: `127.0.0.1:${port}` } } }));
  const tcpPage = await openShell(t, tcp, '/');
  await tcpPage.getByRole('region', { name: 'Set up Kiln' }).getByRole('alert').filter({ hasText: /raw TCP.*local Admin/ }).waitFor();
});

test('on a dev instance the wizard has no Import step: it ends with Demo', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  await wizard.getByRole('heading', { name: 'Login', level: 3 }).waitFor();
  await wizard.getByText('Step 1 of 7').waitFor();
  const steps = wizard.getByRole('list', { name: 'Setup steps' }).getByRole('listitem');
  assert.deepEqual(await steps.allInnerTexts(), ['Login', 'Knowledge store', 'Install', 'Agents', 'Models', 'Workflow roles', 'Demo']);
});

/** Walks a dev core's wizard to its Demo step, with Work picked and nothing else chosen. */
async function toDemoStep(t: Parameters<typeof tempDir>[0], kiln: Awaited<ReturnType<typeof startTestKiln>>, onRoles?: (wizard: Locator) => Promise<void>) {
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  for (const name of ['Login', 'Knowledge store', 'Install', 'Agents', 'Models', 'Workflow roles']) {
    await wizard.getByRole('heading', { name, level: 3 }).waitFor();
    if (name === 'Install') await wizard.getByRole('radio', { name: /Work/ }).check();
    if (name === 'Workflow roles') {
      await wizard.getByText('Replay needs no models; set them before running Live').waitFor();
      await onRoles?.(wizard);
    }
    await wizard.getByRole('button', { name: 'Next' }).click();
  }
  await wizard.getByRole('heading', { name: 'Demo', level: 3 }).waitFor();
  return { page, wizard };
}

test('on a dev instance, Live with no role models shows why and stays on the Demo step; Replay then finishes and opens the demo Story at Grill', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  // No Agent installed and no role given a model: the Agents and Workflow roles steps are left empty.
  const { page, wizard } = await toDemoStep(t, kiln, async (w) => {
    assert.equal(await w.getByLabel('implementer model', { exact: true }).inputValue(), '');
  });
  await wizard.getByText(/The demo is a small Project/).waitFor();
  const finish = wizard.getByRole('button', { name: 'Finish' });
  assert.equal(await finish.isDisabled(), true, 'a choice comes first');

  await wizard.getByRole('radio', { name: /Live/ }).check();
  await finish.click();
  await wizard.getByRole('alert').filter({ hasText: /Live runs on your role models: choose a model for the griller role.*the reviewer role/ }).waitFor();
  await wizard.getByRole('heading', { name: 'Demo', level: 3 }).waitFor();
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);

  await wizard.getByRole('radio', { name: /Replay/ }).check();
  await finish.click();
  await page.waitForURL(`${kiln.url}/`);
  assert.equal((await kiln.api<SetupState>('GET', '/api/setup')).completed, true);
  await page.getByRole('link', { name: 'Demo', exact: true }).first().click();
  await page.getByRole('region', { name: 'Story Grill', exact: true }).getByRole('article', { name: 'Add `slugify(title)`', exact: true }).waitFor();
});

test('on a dev instance, Skip finishes with no demo Project', async (t) => {
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  // With no Replay demo the roles still need models: this Budget's model is suggested for each.
  await kiln.api('PUT', '/api/budgets/work-credits', { kind: 'metered', name: 'Work credits', models: ['work-model'] });
  const { page, wizard } = await toDemoStep(t, kiln, async (w) => {
    assert.equal(await w.getByLabel('implementer model', { exact: true }).inputValue(), 'work-model');
  });
  await wizard.getByRole('radio', { name: /Skip/ }).check();
  await wizard.getByRole('button', { name: 'Finish' }).click();

  await page.waitForURL(`${kiln.url}/`);
  assert.equal((await kiln.api<SetupState>('GET', '/api/setup')).completed, true);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
  assert.deepEqual(await kiln.api<DemoState>('GET', '/api/demo'), { available: true });
});

test('a core that has been set up opens on the board, not the wizard', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln, '/');
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Set up Kiln' }).count(), 0);
});
