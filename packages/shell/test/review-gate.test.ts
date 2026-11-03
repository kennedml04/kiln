import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';

test('a person reads the review findings and diff summary in Needs you and approves the Gate; the Ticket ships', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: 'feature.txt', content: 'columns\n' },
        { do: 'commit', message: 'Draw the columns' },
      ],
      reviewer: [
        { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good: one column per run state.\n' },
        { do: 'commit', message: 'Review findings' },
      ],
    },
  });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const page = await openShell(t, kiln, '/needs-you');
  const events = await kiln.events();

  await kiln.api('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const ask = page.getByRole('article', { name: /^Approve Draw the columns/ });
  await ask.waitFor({ timeout: 30_000 });
  await ask.getByText('Review', { exact: true }).waitFor();
  await ask.getByRole('region', { name: 'Review findings' }).getByText(/Looks good: one column per run state/).waitFor();
  await ask.getByRole('region', { name: 'What the branch changes' }).getByText(/feature\.txt/).waitFor();

  // Rejecting needs a comment first.
  await ask.getByRole('radio', { name: 'Reject' }).check();
  assert.equal(await ask.getByRole('button', { name: 'Answer' }).isDisabled(), true);
  await ask.getByRole('radio', { name: 'Approve' }).check();
  await ask.getByRole('button', { name: 'Answer' }).click();
  await ask.waitFor({ state: 'detached' });

  await events.next('item.merged', { timeoutMs: 30_000 });
  const shipped = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === ticket.id)!;
  assert.equal(shipped.stage, 'shipped');
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
});
