// No commit with a Co-Authored-By trailer reaches the default branch through Kiln, whatever the
// Workflow says and whichever Agent made it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, ExitCheckedEvent, Item, Project, SessionMessageEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScripts, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const TICKET = 'Draw the columns';
const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';
const TRAILER = 'co-authored-by: Some Model <noreply@example.com>';

const REVIEWER = [
  { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good.\n' },
  { do: 'commit', message: 'Review findings' },
] as const;

async function setUp(kiln: TestKiln, scripts: FakeAgentScripts) {
  await kiln.installFakeAgent({ script: scripts });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === TICKET)!;
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  return { ticket, events };
}

type Events = Awaited<ReturnType<TestKiln['events']>>;

const reviewAsk = async (events: Events): Promise<Ask> => {
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === 'review') return raised.payload.ask;
  }
};

const approve = (kiln: TestKiln, ask: Ask) => kiln.api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });

test('a commit with a Co-Authored-By trailer fails the Exit, the Agent is told which and how to fix it, and the fixed branch merges', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await setUp(kiln, {
    implementer: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'commit', message: `Draw the columns\n\nSome detail.\n\n${TRAILER}` },
      { do: 'finish', message: 'Done.' },
      { do: 'commit', message: 'Draw the columns\n\nSome detail.', amend: true },
    ],
    reviewer: [...REVIEWER],
  });

  const first = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(first.payload.exit.met, false);
  const failed = first.payload.exit.checks.filter((c) => !c.met);
  assert.deepEqual(failed.map((c) => c.id), ['no_coauthor_trailers']);
  assert.match(failed[0]!.detail!, /[0-9a-f]{7,} Draw the columns/);
  const feedback = await events.next<SessionMessageEvent>('session.message');
  assert.match(feedback.payload.text, /Co-Authored-By/);
  assert.match(feedback.payload.text, /Draw the columns/);
  assert.match(feedback.payload.text, /git commit --amend/);

  const second = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(second.payload.exit.met, true, JSON.stringify(second.payload.exit.checks));
  assert.ok(second.payload.exit.checks.some((c) => c.id === 'no_coauthor_trailers' && c.met));

  await approve(kiln, await reviewAsk(events));
  await events.next('item.merged', { timeoutMs: 30_000 });
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  // Nothing on main carries the trailer, Kiln's own commits included.
  assert.doesNotMatch(kiln.repo.git('log', '--format=%B', 'main'), /co-authored-by/i);
  assert.match(kiln.repo.git('log', '--format=%s', 'main'), /^Kiln: /m);
});

test('the merge itself refuses a branch with a Co-Authored-By commit that got past the Exit, and main is left as it was', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await setUp(kiln, {
    implementer: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns' },
    ],
    reviewer: [...REVIEWER],
  });
  const ask = await reviewAsk(events);
  // A trailer commit lands on the branch after the Exit was checked.
  const branch = ask.review!.branch;
  const tree = kiln.repo.git('rev-parse', `${branch}^{tree}`).trim();
  const sneaked = kiln.repo.git('commit-tree', tree, '-p', branch, '-m', `Sneak in\n\nCo-Authored-By: Someone <x@example.com>`).trim();
  kiln.repo.git('update-ref', `refs/heads/${branch}`, sneaked);
  const mainBefore = kiln.repo.git('rev-parse', 'main').trim();

  await approve(kiln, ask);
  const { error } = (await events.next('gate.failed', { timeoutMs: 30_000 })).payload as { error: string };
  assert.match(error, /Co-Authored-By/);
  assert.match(error, new RegExp(sneaked.slice(0, 7)));
  assert.equal(kiln.repo.git('rev-parse', 'main').trim(), mainBefore);
  assert.doesNotMatch(kiln.repo.git('log', '--format=%B', 'main'), /co-authored-by/i);
});

test('only a real trailer (with an address) counts: a message that mentions Co-Authored-By: in a sentence meets the Exit and merges', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await setUp(kiln, {
    implementer: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns\n\nA commit with a Co-Authored-By: line fails the Exit.' },
    ],
    reviewer: [...REVIEWER],
  });
  const exit = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
  await approve(kiln, await reviewAsk(events));
  await events.next('item.merged', { timeoutMs: 30_000 });
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
});

test('a trailer folded into the subject line of a one-line commit still fails the Exit', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await setUp(kiln, {
    implementer: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns Co-Authored-By: Some Model <noreply@example.com>' },
    ],
    reviewer: [...REVIEWER],
  });
  const exit = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.deepEqual(exit.payload.exit.checks.filter((c) => !c.met).map((c) => c.id), ['no_coauthor_trailers']);
});
