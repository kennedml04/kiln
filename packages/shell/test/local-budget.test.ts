import { test } from 'node:test';
import type { Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

test('the header shows how many local Sessions are running', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script: [{ do: 'progress', text: 'thinking locally' }, { do: 'wait_for_message' }] });
  await kiln.api('PUT', '/api/budgets/home', { kind: 'local', name: 'Home GPU', models: ['fake-model'] });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  const header = page.getByRole('banner');
  await header.getByRole('meter', { name: 'Home GPU budget' }).waitFor();
  await header.getByText('Home GPU: No Sessions running').waitFor();

  await page
    .getByRole('region', { name: 'Ticket Implementing', exact: true })
    .getByRole('link', { name: 'Draw the columns' })
    .click();
  await page.getByRole('button', { name: 'Start Session' }).click();
  await page.getByRole('log', { name: 'Thread' }).getByText('thinking locally').waitFor();
  await header.getByText('Home GPU: 1 Session running').waitFor();

  const [session] = await kiln.api<{ id: string }[]>('GET', '/api/sessions');
  await agent.stopSession(session!.id);
  await header.getByText('Home GPU: No Sessions running').waitFor();
});
