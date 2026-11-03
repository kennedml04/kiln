import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, Item, Project, SessionAgentEvent, SessionStartedEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScripts, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const TICKET = 'Draw the columns';
const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';

const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}"`);
  return item;
};

/** The implementer writes and commits a feature; the reviewer writes and commits its findings. */
const SCRIPTS: FakeAgentScripts = {
  implementer: [
    { do: 'write', path: 'feature.txt', content: 'columns\n' },
    { do: 'commit', message: 'Draw the columns' },
  ],
  reviewer: [
    { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good: one column per run state.\n' },
    { do: 'commit', message: 'Review findings' },
  ],
};

/** A seeded Project whose tests always pass, with the fake Agent installed. */
async function setUp(kiln: TestKiln, scripts: FakeAgentScripts = SCRIPTS) {
  await kiln.installFakeAgent({ script: scripts });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), TICKET);
  return { project, ticket };
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

const reviewAsk = async (events: Awaited<ReturnType<TestKiln['events']>>): Promise<Ask> => {
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === 'review') return raised.payload.ask;
  }
};

test('entering Review starts a review Session that writes findings, then a blocking Review Ask shows them with the diff summary', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket } = await setUp(kiln);
  const events = await kiln.events();

  await start(kiln, ticket);
  let review: SessionStartedEvent;
  do review = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 30_000 });
  while (review.payload.session.stage !== 'review');
  assert.equal(review.payload.session.role, 'reviewer');
  assert.equal(review.payload.itemId, ticket.id);

  const ask = await reviewAsk(events);
  assert.equal(ask.itemId, ticket.id);
  assert.equal(ask.blocking, true);
  assert.equal(ask.state, 'open');
  assert.match(ask.review!.findings, /Looks good: one column per run state/);
  assert.match(ask.review!.diffSummary, /feature\.txt/);
  assert.equal(ask.review!.branch, 'kiln/ticket/home-board/01');

  const open = await kiln.api<Ask[]>('GET', '/api/asks');
  assert.deepEqual(open.map((a) => a.id), [ask.id]);
  const item = byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET);
  assert.equal(item.stage, 'review');
  assert.equal(item.runState, 'waiting');
});

const answer = (kiln: TestKiln, ask: Ask, body: { answer: string; comment?: string }) =>
  kiln.request<Ask & { error?: string }>('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, body);

/** Starts the Ticket and waits for its Gate's Review Ask. */
async function atGate(kiln: TestKiln, scripts?: FakeAgentScripts) {
  const setup = await setUp(kiln, scripts);
  const events = await kiln.events();
  await start(kiln, setup.ticket);
  return { ...setup, events, ask: await reviewAsk(events) };
}

test('approving the Gate merges the branch into main, removes the worktree and ships the Ticket', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket, events, ask } = await atGate(kiln);

  const answered = await answer(kiln, ask, { answer: 'Approve' });
  assert.equal(answered.status, 200);
  await events.next('item.merged', { timeoutMs: 30_000 });
  const shipped = byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET);
  assert.equal(shipped.id, ticket.id);
  assert.equal(shipped.stage, 'shipped');
  assert.equal(shipped.runState, 'shipped');
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  assert.match(kiln.repo.git('show', `main:${FINDINGS}`), /Looks good/);
  assert.equal(kiln.repo.git('branch', '--list', 'kiln/*').trim(), '');
  assert.equal(kiln.repo.git('worktree', 'list').trim().split('\n').length, 1);
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), []);
});

/** The implementer reports what it was seeded with, so a rework Session's seed shows in its Thread. */
const REWORK_SCRIPTS: FakeAgentScripts = {
  implementer: [
    { do: 'progress', text: 'comment: {artifact:Review comment} | findings: {artifact:Review findings} | conflict: {artifact:Merge conflict}' },
    { do: 'write', path: 'feature.txt', content: 'columns {session}\n' },
    { do: 'commit', message: 'Draw the columns' },
  ],
  reviewer: SCRIPTS.reviewer!,
};

const seededProgress = async (events: Awaited<ReturnType<TestKiln['events']>>) => {
  for (;;) {
    const event = await events.next<SessionAgentEvent<'progress'>>('session.progress', { timeoutMs: 30_000 });
    if (event.payload.text?.startsWith('comment: ')) return event.payload.text;
  }
};

test('rejecting the Gate needs a comment, then sends the Ticket back to Implementing with a fresh Session seeded with the comment and findings', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket, events, ask } = await atGate(kiln, REWORK_SCRIPTS);
  assert.match(await seededProgress(events), /comment: \(none\)/);

  const bare = await answer(kiln, ask, { answer: 'Reject' });
  assert.equal(bare.status, 400);
  assert.equal((await kiln.api<Ask>('GET', `/api/asks/${encodeURIComponent(ask.id)}`)).state, 'open');

  const rejected = await answer(kiln, ask, { answer: 'Reject', comment: 'Give each column a header.' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.comment, 'Give each column a header.');

  let rework: SessionStartedEvent;
  do rework = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 30_000 });
  while (rework.payload.session.stage !== 'implementing');
  assert.equal(rework.payload.itemId, ticket.id);
  const seeded = await seededProgress(events);
  assert.match(seeded, /comment: Give each column a header\./);
  assert.match(seeded, /findings: # Review\s+Looks good/);
  assert.throws(() => kiln.repo.git('show', 'main:feature.txt'), 'a rejected branch is not merged');
});

test('a merge conflict raises a blocking Decision Ask and leaves main untouched; rebasing sends the Ticket back with the conflict', async (t) => {
  const kiln = await startTestKiln(t);
  const { events, ask } = await atGate(kiln, REWORK_SCRIPTS);
  assert.match(await seededProgress(events), /conflict: \(none\)/);
  writeRepoFile(kiln.repo, 'feature.txt', 'rows instead\n');
  kiln.repo.git('add', 'feature.txt');
  kiln.repo.git('commit', '-q', '-m', 'Someone else drew rows');
  const before = kiln.repo.git('rev-parse', 'main').trim();

  assert.equal((await answer(kiln, ask, { answer: 'Approve' })).status, 200);
  let decision: Ask;
  do decision = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 })).payload.ask;
  while (decision.type !== 'decision');
  assert.equal(decision.blocking, true);
  assert.match(decision.why, /feature\.txt/);
  assert.equal(decision.recommendation, 'Rebase in a fresh Implementing Session');
  assert.equal(kiln.repo.git('rev-parse', 'main').trim(), before);
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'rows instead\n');
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET).stage, 'review');

  assert.equal((await answer(kiln, decision, { answer: decision.recommendation })).status, 200);
  const seeded = await seededProgress(events);
  assert.match(seeded, /conflict: .*feature\.txt/s);
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET).stage, 'implementing');
});

test('an Item at its Gate cannot be dragged past it', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket } = await atGate(kiln);
  const moved = await kiln.request('PATCH', `/api/items/${encodeURIComponent(ticket.id)}`, { stage: 'shipped' });
  assert.equal(moved.status, 409);
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), TICKET).stage, 'review');
});
