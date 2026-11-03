import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, OrgPolicy, Project, SessionAgentEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { readRepoFile, seedScratch } from '@kiln/testing/scratch';

test('a person answers a Permission Ask in Needs you with Always allow', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'permission', action: 'other_commands', detail: 'npm run lint' }] });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const page = await openShell(t, kiln, '/needs-you');
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session);

  const ask = page.getByRole('article', { name: 'Run a shell command: npm run lint?' });
  await ask.getByText('Permission', { exact: true }).waitFor();
  await ask.getByText('Blocking').waitFor();
  assert.equal(await ask.getByRole('radio', { name: 'Allow once' }).isChecked(), true);
  await ask.getByRole('radio', { name: 'Always allow' }).check();
  await ask.getByRole('button', { name: 'Answer' }).click();
  await ask.waitFor({ state: 'detached' });

  for (;;) {
    const text = (await events.next<SessionAgentEvent<'progress'>>('session.progress', { timeoutMs: 15_000 })).payload.text;
    if (text?.startsWith('permission ')) {
      assert.equal(text, 'permission allow');
      break;
    }
  }
  assert.deepEqual(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules, [
    { action: 'other_commands', match: 'npm run lint', decision: 'allow' },
  ]);
});

test('an Admin edits the Org Policy in Settings, and a Member gets no Settings', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: 'Settings' }).click();
  const form = page.getByRole('form', { name: 'Org Policy' });
  const shell = form.getByRole('combobox', { name: 'Run a shell command' });
  assert.equal(await shell.inputValue(), 'allow');
  assert.equal(await form.getByRole('combobox', { name: 'Act outside the worktree' }).inputValue(), 'ask');
  await shell.selectOption('deny');
  await form.getByRole('button', { name: 'Save the Org Policy' }).click();
  await form.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.equal((await kiln.api<OrgPolicy>('GET', '/api/org-policy')).actions.other_commands, 'deny');

  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const member = await openShell(t, kiln, '/', { as: 'mo' });
  await member.getByRole('link', { name: /^Needs you/ }).waitFor();
  assert.equal(await member.getByRole('link', { name: 'Settings' }).count(), 0);
});
