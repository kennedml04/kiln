// Linked Projects, slice 1: a client Item's Session gets side-by-side worktrees of the client and each
// linked Project on one branch name; the link command runs; ending the Session cleans them all up and
// drops a linked repo it never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ask, Item, Project, SessionInfo, StartResult } from '@kiln/widget-sdk';
import { createTempRepo, startTestKiln, type FakeAgentScripts, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const BRANCH = 'kiln/ticket/home-board/01';

const waitFor = async (what: string, ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await ok()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
};

async function setUp(t: Parameters<typeof startTestKiln>[0], script: FakeAgentScripts) {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script });
  const lib = createTempRepo(t);
  const logDir = mkdtempSync(join(tmpdir(), 'kiln-link-'));
  const log = join(logDir, 'link.log');
  const command = `node -e "require('fs').appendFileSync(process.argv[1], process.cwd() + '\\n')" "${log}"`;
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version', linkedProjects: { lib: { link: command } } }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the settings');
  await kiln.api<Project>('POST', '/api/projects', { path: lib.path, name: 'lib' });
  const client = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path, name: 'client' });
  assert.deepEqual(client.errors, []);
  const items = await kiln.api<Item[]>('GET', `/api/projects/${client.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  return { kiln, lib, log, ticket };
}

const sessionOf = async (kiln: TestKiln, itemId: string) => {
  let found: SessionInfo | undefined;
  await waitFor('the Session to finish', async () => {
    const all = await kiln.api<SessionInfo[]>('GET', '/api/sessions');
    found = all.find((s) => s.itemId === itemId && s.state === 'finished');
    return found !== undefined;
  });
  return found!;
};

test('a client Session works in side-by-side worktrees, runs the link, and drops a linked repo it never touched', async (t) => {
  const { kiln, lib, log, ticket } = await setUp(t, {
    implementer: [
      { do: 'write', path: 'client/feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns', in: 'client' },
    ],
  });
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  await sessionOf(kiln, ticket.id);

  const ran = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(ran.length >= 1, 'the link command ran');
  assert.match(ran[0]!, /client$/, 'in the client worktree');
  assert.match(ran[0]!, /[\\/]kiln[\\/]|ticket/i);

  // A later Stage's Session may make the worktrees again and drop them again: wait for it all to settle.
  await waitFor('the worktrees to be cleaned up and the untouched repo dropped', () =>
    [kiln.repo, lib].every((r) => r.git('worktree', 'list').trim().split('\n').length === 1) && lib.git('branch', '--list', 'kiln/*').trim() === '');
  assert.ok(kiln.repo.git('branch', '--list', BRANCH).includes(BRANCH), 'the client keeps its branch and its commit');
  assert.equal(lib.git('worktree', 'list').trim().split('\n').length, 1, 'the linked repo has no worktree left');
  assert.equal(lib.git('branch', '--list', 'kiln/*').trim(), '', 'a linked repo the Session never touched has no branch');
  assert.ok(!existsSync(ran[0]!), 'the client worktree is gone');
});

test('a linked repo the Session changed keeps its branch when the Session ends', async (t) => {
  const { kiln, lib, ticket } = await setUp(t, {
    implementer: [
      { do: 'write', path: 'client/feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns', in: 'client' },
      { do: 'write', path: 'lib/shared.txt', content: 'shared\n' },
      { do: 'commit', message: 'Share the columns', in: 'lib' },
    ],
  });
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  await sessionOf(kiln, ticket.id);

  await waitFor('the worktrees to be cleaned up', () => lib.git('worktree', 'list').trim().split('\n').length === 1);
  assert.ok(lib.git('branch', '--list', BRANCH).includes(BRANCH), 'the linked repo keeps the branch it changed');
  assert.equal(lib.git('show', `${BRANCH}:shared.txt`), 'shared\n');
});

// Linked Projects, slice 3: one Review Ask for the whole task, and each touched repo lands on approval.
const FINDINGS = 'client/.scratch/home-board/reviews/01-draw-the-columns.md';
const REVIEWER = [
  { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good.\n' },
  { do: 'commit', message: 'Review findings', in: 'client' },
] as const;

const reviewAskOf = async (kiln: TestKiln, itemId: string): Promise<Ask> => {
  let found: Ask | undefined;
  await waitFor('the Review Ask', async () => {
    found = (await kiln.api<Ask[]>('GET', '/api/asks')).find((a) => a.itemId === itemId && a.type === 'review');
    return found !== undefined;
  });
  return found!;
};

test('one Review Ask shows both repos, and approving lands each touched repo on its default branch', async (t) => {
  const { kiln, lib, ticket } = await setUp(t, {
    implementer: [
      { do: 'write', path: 'client/feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns', in: 'client' },
      { do: 'write', path: 'lib/shared.txt', content: 'shared\n' },
      { do: 'commit', message: 'Share the columns', in: 'lib' },
    ],
    reviewer: [...REVIEWER],
  });
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const ask = await reviewAskOf(kiln, ticket.id);
  assert.deepEqual(ask.review!.repos!.map((r) => r.name), ['lib', 'client'], 'the linked Project lands first');
  assert.match(ask.review!.repos![0]!.diffSummary, /shared\.txt/);
  assert.match(ask.review!.repos![1]!.diffSummary, /feature\.txt/);
  assert.match(ask.question, /lib and client/);

  const res = await kiln.request('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
  assert.equal(res.status, 200);
  await waitFor('both repos to land', () => lib.git('branch', '--list', 'kiln/*').trim() === '' && kiln.repo.git('branch', '--list', 'kiln/*').trim() === '');
  assert.equal(lib.git('show', 'main:shared.txt'), 'shared\n');
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  assert.equal(lib.git('worktree', 'list').trim().split('\n').length, 1);
});

test('a linked repo the Session never touched is not in the Review Ask and is not landed', async (t) => {
  const { kiln, lib, ticket } = await setUp(t, {
    implementer: [
      { do: 'write', path: 'client/feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns', in: 'client' },
    ],
    reviewer: [...REVIEWER],
  });
  const before = lib.git('rev-parse', 'main');
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const ask = await reviewAskOf(kiln, ticket.id);
  assert.equal(ask.review!.repos, undefined, 'only the client changed, so there is one diff');

  await kiln.request('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
  await waitFor('the client to land', () => kiln.repo.git('branch', '--list', 'kiln/*').trim() === '');
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  assert.equal(lib.git('rev-parse', 'main'), before, 'the untouched repo was not changed');
  assert.equal(lib.git('branch', '--list', 'kiln/*').trim(), '');
});
