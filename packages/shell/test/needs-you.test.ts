import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, Item, Project, SessionAgentEvent, SessionInfo, StartResult } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

test('a person answers a blocking Ask in Needs you, and the badge on every page follows live', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      {
        do: 'ask',
        ask: {
          type: 'decision',
          question: 'Store the columns in SQLite or in the Tracker?',
          why: 'The board layout depends on it.',
          recommendation: 'SQLite',
          options: ['SQLite', 'Tracker'],
          blocking: true,
        },
      },
      { do: 'progress', text: 'after the Ask' },
      { do: 'wait_for_message' },
    ],
  });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);
  const badge = page.getByRole('link', { name: /^Needs you/ });
  await badge.and(page.getByLabel('Needs you, nothing open')).waitFor();

  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session);
  await badge.and(page.getByLabel('Needs you, 1 open')).waitFor();

  await badge.click();
  const ask = page.getByRole('article', { name: 'Store the columns in SQLite or in the Tracker?' });
  await ask.getByText('The board layout depends on it.').waitFor();
  await ask.getByText('Blocking').waitFor();
  await ask.getByRole('link', { name: 'Draw the columns' }).waitFor();
  assert.equal(await ask.getByRole('radio', { name: 'SQLite' }).isChecked(), true, 'the recommendation is chosen to start with');

  await ask.getByRole('radio', { name: 'Tracker' }).check();
  await ask.getByRole('button', { name: 'Answer' }).click();
  await ask.waitFor({ state: 'detached' });
  await badge.and(page.getByLabel('Needs you, nothing open')).waitFor();
  await page.getByText('Nothing needs you.').waitFor();

  const answered = (await kiln.api<Ask[]>('GET', '/api/asks?state=answered'))[0];
  assert.equal(answered?.answer, 'Tracker');
  const heard: string[] = [];
  while (heard.at(-1) !== 'after the Ask') {
    heard.push((await events.next<SessionAgentEvent<'progress'>>('session.progress', { timeoutMs: 15_000 })).payload.text ?? '');
  }
  assert.ok(heard.includes('answered: Tracker'), 'the Session heard the answer');
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'running');
});
