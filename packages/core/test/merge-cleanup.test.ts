// Issue 10: an approved Gate ships the Item even when its worktree is slow or impossible to remove,
// and approving a branch that is already merged ships it without merging again or asking again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Ask, AskRaisedEvent, Item, ItemCleanupFailedEvent, ItemMergedEvent, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScripts, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const TICKET = 'Draw the columns';
const BRANCH = 'kiln/ticket/home-board/01';
const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';

const SCRIPTS: FakeAgentScripts = {
  implementer: [
    { do: 'write', path: 'feature.txt', content: 'columns\n' },
    { do: 'commit', message: 'Draw the columns' },
  ],
  reviewer: [
    { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good.\n' },
    { do: 'commit', message: 'Review findings' },
  ],
};

const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}"`);
  return item;
};

/** Starts the Ticket and waits for its Gate's Review Ask. */
async function atGate(kiln: TestKiln) {
  await kiln.installFakeAgent({ script: SCRIPTS });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), TICKET);
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === 'review') return { ticket, events, ask: raised.payload.ask };
  }
}

const approve = async (kiln: TestKiln, ask: Ask) => {
  const answered = await kiln.request('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
  assert.equal(answered.status, 200);
};

/** The Item's worktree folder, from `git worktree list` (the first entry is the repo itself). */
const worktreePath = (kiln: TestKiln): string => {
  const paths = kiln.repo.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  assert.equal(paths.length, 2, 'the Ticket has one worktree');
  return paths[1]!;
};

const assertShipped = async (kiln: TestKiln) => {
  const item = byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET);
  assert.equal(item.stage, 'shipped');
  assert.equal(item.runState, 'shipped');
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), [], 'no Ask is raised again');
};

test('a worktree a process holds for a moment is still removed once it lets go, and the Ticket ships', async (t) => {
  const kiln = await startTestKiln(t);
  const { events, ask } = await atGate(kiln);
  // An Agent's process that is still exiting: on Windows its working folder cannot be removed yet.
  const worktree = worktreePath(kiln);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: worktree, stdio: 'ignore', windowsHide: true });
  t.after(() => holder.kill());

  await approve(kiln, ask);
  await events.next('item.merged', { timeoutMs: 30_000 });
  await assertShipped(kiln);
  assert.ok(!existsSync(worktree), 'the worktree folder is removed');
  assert.equal(kiln.repo.git('worktree', 'list').trim().split('\n').length, 1);
  assert.equal(kiln.repo.git('branch', '--list', 'kiln/*').trim(), '');
});

test('a worktree that cannot be removed is reported, and the Ticket ships anyway', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket, events, ask } = await atGate(kiln);
  kiln.repo.git('worktree', 'lock', worktreePath(kiln));

  await approve(kiln, ask);
  const failed = await events.next<ItemCleanupFailedEvent>('item.cleanup_failed', { timeoutMs: 30_000 });
  assert.equal(failed.payload.itemId, ticket.id);
  assert.equal(failed.payload.branch, BRANCH);
  await events.next('item.merged', { timeoutMs: 30_000 });
  await assertShipped(kiln);
});

test('approving a branch someone already merged by hand ships the Ticket without merging it again', async (t) => {
  const kiln = await startTestKiln(t);
  const { events, ask } = await atGate(kiln);
  kiln.repo.git('merge', '-q', '--no-ff', '-m', 'Merged by hand', BRANCH);
  const merged = kiln.repo.git('rev-parse', 'main').trim();

  await approve(kiln, ask);
  const done = await events.next<ItemMergedEvent>('item.merged', { timeoutMs: 30_000 });
  assert.equal(done.payload.commit, merged, 'the hand merge is the merge');
  await assertShipped(kiln);
  // Only the Stage change is recorded on top of it, with no second merge commit.
  assert.equal(kiln.repo.git('log', '--merges', '--format=%s', 'main').trim(), 'Merged by hand');
});
