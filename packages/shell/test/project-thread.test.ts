import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

test('a person chats in the Project Thread, and accepts its proposal in Needs you', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = items.find((i) => i.title === 'Home board')!;
  await kiln.installFakeAgent({
    script: [
      { do: 'wait_for_message' },
      {
        do: 'ask',
        ask: {
          type: 'decision',
          question: 'Add a Ticket for the cards?',
          why: 'Nothing draws the cards yet.',
          recommendation: 'Accept',
          blocking: true,
          proposal: { kind: 'create_items', items: [{ kind: 'ticket', title: 'Draw the cards', parentId: story.id }] },
        },
      },
      { do: 'wait_for_message' },
    ],
  });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  await page.getByRole('link', { name: 'Project Thread' }).click();
  await page.getByRole('heading', { name: `${project.name} Project Thread` }).waitFor();
  await page.getByRole('textbox', { name: 'Message' }).fill('What is missing?');
  await page.getByRole('button', { name: 'Send' }).click();
  const log = page.getByRole('log', { name: 'Thread' });
  await log.getByText('Person: What is missing?').waitFor();
  await log.getByText('heard: What is missing?').waitFor();

  const badge = page.getByRole('link', { name: /^Needs you/ });
  await badge.and(page.getByLabel('Needs you, 1 open')).waitFor();
  await badge.click();
  const ask = page.getByRole('article', { name: 'Add a Ticket for the cards?' });
  await ask.getByRole('link', { name: `${project.name} Project Thread` }).waitFor();
  await ask.getByText('Proposed: create Ticket "Draw the cards"').waitFor();
  assert.equal(await ask.getByRole('radio', { name: 'Accept' }).isChecked(), true);
  await ask.getByRole('button', { name: 'Answer' }).click();
  await ask.waitFor({ state: 'detached' });

  await page.goto(new URL(`/projects/${project.id}`, page.url()).href);
  await page.getByRole('link', { name: 'Draw the cards' }).waitFor();
  const after = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.ok(after.some((i) => i.title === 'Draw the cards' && i.parentId === story.id));
});
