// What the GitHub Tracker does beyond the shared contract: the token stays a Platform secret, Kiln
// writes only Stage and Status labels, and content edits never come from the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, ItemStageChangedEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { startFakeGitHub } from '@kiln/testing/fake-github';
import { CONTRACT_TREE } from '@kiln/testing/tracker-contract';
import { byTitle, registerGitHubProject, seedIssues, startGitHubWidget } from './helpers.ts';

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

test('the GitHub token is a Platform secret: every GitHub call carries it, and no file in the data folder holds it', { timeout: 120_000 }, async (t) => {
  const kiln = await startTestKiln(t);
  const fake = await startFakeGitHub(t);
  seedIssues(fake);
  await startGitHubWidget(t, kiln, { apiUrl: fake.url, token: fake.token });
  await registerGitHubProject(kiln, fake.repo);

  const requests = fake.requests();
  assert.ok(requests.length > 0);
  assert.deepEqual([...new Set(requests.map((r) => r.authorization))], [`Bearer ${fake.token}`]);
  const holding = filesUnder(kiln.dataDir).filter((file) => readFileSync(file).includes(fake.token));
  assert.deepEqual(holding, [], 'the token is kept in the OS credential store, not in Kiln files');
});

test("a Stage change is only a label change: the issue's other labels, title and body are left alone", { timeout: 120_000 }, async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: 'feature.txt', content: 'columns\n' },
        { do: 'commit', message: 'Draw the columns' },
      ],
      reviewer: [{ do: 'wait_for_message' }],
    },
  });
  const fake = await startFakeGitHub(t);
  const { ready } = seedIssues(fake);
  await startGitHubWidget(t, kiln, { apiUrl: fake.url, token: fake.token });
  const project = await registerGitHubProject(kiln, fake.repo);
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.ready);
  const events = await kiln.events();

  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 30_000 });

  const issue = fake.issue(ready.number);
  assert.deepEqual([...issue.labels].sort(), ['area:board', 'kind:ticket', 'stage:review', 'status:in-review']);
  assert.deepEqual([issue.title, issue.body, issue.state], [CONTRACT_TREE.ready, 'One column per run state.', 'open']);
  const patches = fake.requests().filter((r) => r.method === 'PATCH');
  assert.ok(patches.length > 0);
  for (const patch of patches) assert.deepEqual(Object.keys(patch.body as object).sort(), ['labels', 'state']);
});

test("the board can't edit an issue's content: that comes only from Sessions", { timeout: 120_000 }, async (t) => {
  const kiln = await startTestKiln(t);
  const fake = await startFakeGitHub(t);
  seedIssues(fake);
  await startGitHubWidget(t, kiln, { apiUrl: fake.url, token: fake.token });
  const project = await registerGitHubProject(kiln, fake.repo);
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.ready);

  const edit = await kiln.request('PATCH', `/api/items/${encodeURIComponent(ticket.id)}`, { title: 'Renamed on the board' });
  assert.equal(edit.status, 409);
  assert.deepEqual(fake.requests().filter((r) => r.method !== 'GET'), []);
});
