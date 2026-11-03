import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OLD_BOARD_DATA_FOLDER, type BudgetInfo, type Project, type SetupState, type WidgetInfo } from '@kiln/widget-sdk';
import { createFakeWidgetRepo, createTempRepo, startTestKiln, tempDir } from '@kiln/testing';
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
  const kiln = await startTestKiln(t, { setup: 'fresh', env: { KILN_OLD_BOARD_REGISTRY: registry } });
  const page = await openShell(t, kiln, '/');
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  const next = () => wizard.getByRole('button', { name: 'Next' }).click();
  const step = (name: string) => wizard.getByRole('heading', { name, level: 3 }).waitFor();

  // Login mode: Tailscale warns that tailscale serve would make every caller the local Admin.
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
  await wizard.getByText('Your Agents run: claude-test-model').waitFor();
  await wizard.getByRole('group', { name: 'Work credits' }).getByLabel('Models').fill('claude-test-model, cheap-test-model');
  await next();

  // Every default Workflow role needs a model: no silent default.
  await step('Workflow roles');
  assert.equal(await wizard.getByRole('button', { name: 'Next' }).isDisabled(), true);
  await wizard.getByLabel('implementer model', { exact: true }).selectOption('claude-test-model');
  await wizard.getByLabel('implementer fallback', { exact: true }).selectOption('cheap-test-model');
  await wizard.getByLabel('reviewer model', { exact: true }).selectOption('cheap-test-model');
  for (const role of ['griller', 'spec-writer', 'ticket-writer']) {
    await wizard.getByLabel(`${role} model`, { exact: true }).selectOption('claude-test-model');
  }
  await next();

  // The one-time import from the old board.
  await step('Import');
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

test('a core that has been set up opens on the board, not the wizard', async (t) => {
  const kiln = await startTestKiln(t);
  const page = await openShell(t, kiln, '/');
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Set up Kiln' }).count(), 0);
});
