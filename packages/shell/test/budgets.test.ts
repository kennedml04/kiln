import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetInfo, Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

test('the header shows the monthly gauge and a running Item shows its live credits, tokens, context and cap warning', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'usage', model: 'fake-model', inputTokens: 1_000, cacheReadTokens: 2_000, outputTokens: 300, costUsd: 0.1 },
      { do: 'progress', text: 'one turn in' },
      { do: 'wait_for_message' },
    ],
  });
  await kiln.api<BudgetInfo>('PUT', '/api/budgets/work', { kind: 'metered', name: 'Work', models: ['fake-model'], perSession: { cost: 10 } });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  const header = page.getByRole('banner');
  await header.getByRole('meter', { name: 'Work budget' }).waitFor();
  await header.getByText('Work: 0 of 10,000 credits this month').waitFor();

  await page
    .getByRole('region', { name: 'Ticket Implementing', exact: true })
    .getByRole('link', { name: 'Draw the columns' })
    .click();
  await page.getByRole('button', { name: 'Start Session' }).click();
  await page.getByRole('log', { name: 'Thread' }).getByText('one turn in').waitFor();

  const usage = page.getByRole('region', { name: 'Usage' });
  await usage.getByText('5 credits', { exact: true }).waitFor();
  await usage.getByText('3,300', { exact: true }).waitFor();
  await usage.getByText('3,000 tokens', { exact: true }).waitFor();
  await usage.getByRole('status').filter({ hasText: 'Session limit at half: 5 of 10 credits' }).waitFor();
  await header.getByText('Work: 5 of 10,000 credits this month').waitFor();

  const text = (await page.locator('body').innerText()).toLowerCase();
  assert.ok(!/estimat/.test(text), 'no estimate is shown');
});

test("a subscription Budget's header shows each window, and its page shows Fable and week use by Project, Stage and Item kind", async (t) => {
  const kiln = await startTestKiln(t);
  const quota = (window: string, percent: number, model: string | null = null) =>
    ({ do: 'quota', reading: { window, model, percent, resetsAt: '2026-11-09T09:00:00.000Z' } }) as const;
  await kiln.installFakeAgent({
    script: [
      quota('week', 40),
      quota('seven_day_model', 20, 'Fable'),
      { do: 'usage', model: 'fake-fable', inputTokens: 1_000, outputTokens: 0 },
      quota('week', 45),
      quota('seven_day_model', 26, 'Fable'),
      { do: 'progress', text: 'read the plan' },
      { do: 'wait_for_message' },
    ],
  });
  await kiln.api('POST', '/api/test/clock', { now: '2026-11-04T09:00:00.000Z' });
  await kiln.api<BudgetInfo>('PUT', '/api/budgets/home', { kind: 'subscription', name: 'Home', models: ['fake-model', 'fake-fable'], perSession: { share: 50 } });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);
  await page
    .getByRole('region', { name: 'Ticket Implementing', exact: true })
    .getByRole('link', { name: 'Draw the columns' })
    .click();
  await page.getByRole('button', { name: 'Start Session' }).click();
  await page.getByRole('log', { name: 'Thread' }).getByText('read the plan').waitFor();

  const header = page.getByRole('banner');
  await header.getByRole('meter', { name: 'Home Week' }).waitFor();
  await header.getByText('Week: 45% used, pace 29%, resets in 5d 0h').waitFor();
  await header.getByText('Fable: 26% used, resets in 5d 0h').waitFor();
  await header.getByText('5-hour window: unknown').waitFor();

  await header.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('heading', { name: 'Home', level: 2 }).waitFor();
  const fable = page.getByRole('region', { name: 'Fable use' });
  await fable.getByText(/approximate/).waitFor();
  const byKind = fable.getByRole('table', { name: 'By Item kind' });
  await byKind.getByRole('row', { name: 'ticket 6%' }).waitFor();
  const week = page.getByRole('region', { name: 'Week use' });
  await week.getByRole('table', { name: 'By Stage' }).getByRole('row', { name: /5%/ }).waitFor();
  await week.getByRole('table', { name: 'By Project' }).getByRole('row', { name: /5%/ }).waitFor();
});
