import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, Item, ItemStageChangedEvent, Project, SessionAgentEvent, SessionInfo, SessionStartedEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type FakeAgentScripts, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';

const STORY = 'Home board';
const GRILL = '.scratch/home-board/grill.md';
const SPEC = '.scratch/home-board/spec.md';

/** Every role of the default Workflow, scripted: each writes its artifact and commits it. */
const SCRIPTS: FakeAgentScripts = {
  griller: [
    { do: 'write', path: GRILL, content: '# Grill: Home board\n\nQ: One board or many? A: One.\n' },
    { do: 'commit', message: 'Grill record' },
  ],
  'spec-writer': [
    { do: 'write', path: SPEC, content: '# Spec: Home board\n\nOne board shows every Project.\n' },
    { do: 'commit', message: 'Spec' },
  ],
  'ticket-writer': [
    { do: 'kiln_tool', name: 'create_child_item', input: { title: 'Draw the columns', description: 'One column per run state.' } },
    { do: 'kiln_tool', name: 'create_child_item', input: { title: 'Live updates', description: 'Patch the board over SSE.' } },
  ],
  implementer: [
    { do: 'write', path: 'feature.txt', content: 'columns\n' },
    { do: 'commit', message: 'Build it' },
  ],
  // One script serves both Tickets, so it writes both findings files (identical on both branches).
  reviewer: [
    { do: 'write', path: '.scratch/home-board/reviews/01-draw-the-columns.md', content: '# Review\n\nLooks good.\n' },
    { do: 'write', path: '.scratch/home-board/reviews/02-live-updates.md', content: '# Review\n\nLooks good.\n' },
    { do: 'commit', message: 'Review findings' },
  ],
};

type Events = Awaited<ReturnType<TestKiln['events']>>;

const items = (kiln: TestKiln) => kiln.api<Item[]>('GET', '/api/items');
const byTitle = async (kiln: TestKiln, title: string): Promise<Item> => {
  const item = (await items(kiln)).find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}"`);
  return item;
};

/** A Project with no Items yet, whose tests always pass, with the fake Agent installed. */
async function setUp(kiln: TestKiln, scripts: FakeAgentScripts = SCRIPTS) {
  const agent = await kiln.installFakeAgent({ script: scripts });
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const create = (body: { kind: string; title: string; parentId?: string; description?: string }) =>
    kiln.api<Item>('POST', `/api/projects/${project.id}/items`, body);
  const epic = await create({ kind: 'epic', title: 'Board as home' });
  const story = await create({ kind: 'story', title: STORY, parentId: epic.id, description: 'Show every Project on one board.' });
  return { project, epic, story, agent };
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

const stageChange = async (events: Events, itemId: string, to: string) => {
  for (;;) {
    const event = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 90_000 });
    if (event.payload.itemId === itemId && event.payload.to === to) return event;
  }
};

test('a Story starts in Grill, and once its griller commits the grill record in its own worktree Kiln merges it and moves the Story to Spec', async (t) => {
  const kiln = await startTestKiln(t);
  const { story } = await setUp(kiln);
  assert.equal(story.stage, 'grill');
  const events = await kiln.events();

  await start(kiln, story);
  const started = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 90_000 });
  assert.equal(started.payload.session.role, 'griller');
  const worktree = started.payload.session.worktree;
  assert.ok(worktree, 'the Grill Session works in a worktree');
  assert.notEqual(worktree.toLowerCase(), kiln.repo.path.toLowerCase());
  assert.equal(started.payload.session.branch, 'kiln/story/home-board');

  await stageChange(events, story.id, 'spec');
  assert.match(kiln.repo.git('show', `main:${GRILL}`), /One board or many/);
  assert.match(kiln.repo.git('show', 'main:.scratch/home-board/story.md'), /stage: spec/);
  assert.equal((await byTitle(kiln, STORY)).stage, 'spec');
});

/** Starts the Story and approves its Spec Gate, then returns the Tickets Gate's Review Ask. */
async function atTicketsGate(kiln: TestKiln, scripts?: FakeAgentScripts) {
  const setup = await setUp(kiln, scripts);
  const events = await kiln.events();
  await start(kiln, setup.story);
  const spec = await reviewAsk(events, setup.story.id);
  assert.equal((await answer(kiln, spec, { answer: 'Approve' })).status, 200);
  return { ...setup, events, ask: await reviewAsk(events, setup.story.id) };
}

const reviewAsk = async (events: Events, itemId: string): Promise<Ask> => {
  for (;;) {
    const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 90_000 })).payload;
    if (ask.type === 'review' && ask.itemId === itemId) return ask;
  }
};

const answer = (kiln: TestKiln, ask: Ask, body: { answer: string; comment?: string }) =>
  kiln.request<Ask & { error?: string }>('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, body);

test('the Spec Gate shows the spec from the branch; approving it merges the spec and moves the Story to Tickets', async (t) => {
  const kiln = await startTestKiln(t);
  const { story } = await setUp(kiln);
  const events = await kiln.events();
  await start(kiln, story);

  const ask = await reviewAsk(events, story.id);
  assert.equal(ask.raisedBy.kind === 'gate' && ask.raisedBy.stage, 'spec');
  assert.equal(ask.review!.artifact, 'Spec');
  assert.equal(ask.review!.findingsPath, SPEC);
  assert.match(ask.review!.findings, /One board shows every Project/);
  assert.throws(() => kiln.repo.git('show', `main:${SPEC}`), 'the spec is not on main before the Gate is approved');
  assert.equal((await byTitle(kiln, STORY)).runState, 'waiting');

  assert.equal((await answer(kiln, ask, { answer: 'Approve' })).status, 200);
  await stageChange(events, story.id, 'tickets');
  assert.match(kiln.repo.git('show', `main:${SPEC}`), /One board shows every Project/);
});

test('rejecting the Spec Gate reworks the Story in Spec, in a fresh Session seeded with the comment', async (t) => {
  const kiln = await startTestKiln(t);
  const scripts: FakeAgentScripts = {
    ...SCRIPTS,
    'spec-writer': [
      { do: 'progress', text: 'comment: {artifact:Review comment}' },
      { do: 'write', path: SPEC, content: '# Spec: Home board\n\nWritten by {session}.\n' },
      { do: 'commit', message: 'Spec' },
    ],
  };
  const { story } = await setUp(kiln, scripts);
  const events = await kiln.events();
  await start(kiln, story);
  const ask = await reviewAsk(events, story.id);

  assert.equal((await answer(kiln, ask, { answer: 'Reject', comment: 'Say how the board sorts.' })).status, 200);
  let rework: SessionStartedEvent;
  do rework = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 90_000 });
  while (rework.payload.session.stage !== 'spec' || rework.payload.session.startedAt <= ask.raisedAt);
  assert.equal(rework.payload.itemId, story.id);
  for (;;) {
    const progress = await events.next<SessionAgentEvent<'progress'>>('session.progress', { timeoutMs: 90_000 });
    if (progress.payload.sessionId === rework.payload.sessionId && progress.payload.text?.startsWith('comment: ')) {
      assert.equal(progress.payload.text, 'comment: Say how the board sorts.');
      break;
    }
  }
  assert.equal((await byTitle(kiln, STORY)).stage, 'spec');
  assert.ok((await reviewAsk(events, story.id)).id !== ask.id, 'the reworked spec comes back to the Gate');
});

test('the Tickets Stage creates child Tickets through a Kiln tool: they show on the boards at once, and the Tickets Gate lists them', async (t) => {
  const kiln = await startTestKiln(t);
  const { story, ask } = await atTicketsGate(kiln);

  assert.equal(ask.raisedBy.kind === 'gate' && ask.raisedBy.stage, 'tickets');
  assert.equal(ask.review!.artifact, 'Tickets');
  assert.match(ask.review!.findings, /Draw the columns: One column per run state\./);
  assert.match(ask.review!.findings, /Live updates: Patch the board over SSE\./);

  const board = await items(kiln);
  const tickets = board.filter((i) => i.parentId === story.id);
  assert.deepEqual(tickets.map((i) => [i.key, i.title, i.stage]), [
    ['ticket/home-board/01', 'Draw the columns', 'implementing'],
    ['ticket/home-board/02', 'Live updates', 'implementing'],
  ]);
  assert.deepEqual(board.find((i) => i.id === story.id)!.childIds, tickets.map((i) => i.id));
  assert.equal(kiln.repo.git('ls-tree', '-r', '--name-only', 'main', '.scratch/home-board/issues').trim(), '', 'the Tickets are not on main before the Gate is approved');

  const early = await kiln.request<{ error: string }>('POST', `/api/items/${encodeURIComponent(tickets[0]!.id)}/start`);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /worktree/);
});

test('a Ticket added on main while the ticket-writer works does not share a number with the Tickets it writes', async (t) => {
  const kiln = await startTestKiln(t);
  const { project, story, agent } = await setUp(kiln, {
    ...SCRIPTS,
    'ticket-writer': [
      { do: 'wait_for_message' },
      { do: 'kiln_tool', name: 'create_child_item', input: { title: 'Draw the columns', description: 'One column per run state.' } },
    ],
  });
  const events = await kiln.events();
  await start(kiln, story);
  assert.equal((await answer(kiln, await reviewAsk(events, story.id), { answer: 'Approve' })).status, 200);
  let writer: SessionStartedEvent;
  do writer = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 90_000 });
  while (writer.payload.session.stage !== 'tickets');

  const hotfix = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title: 'Hotfix', parentId: story.id });
  await agent.sendMessage(writer.payload.sessionId, { kind: 'text', text: 'go on' });
  await reviewAsk(events, story.id);

  const tickets = (await items(kiln)).filter((i) => i.parentId === story.id);
  assert.deepEqual(tickets.map((i) => [i.key, i.title]).sort(), [
    [hotfix.key, 'Hotfix'],
    ['ticket/home-board/02', 'Draw the columns'],
  ]);
  assert.equal(hotfix.key, 'ticket/home-board/01');
});

test('approving the Tickets Gate merges the Tickets onto main and starts them, while the Story waits for them in Tickets', async (t) => {
  const kiln = await startTestKiln(t);
  const { story, events, ask } = await atTicketsGate(kiln);

  assert.equal((await answer(kiln, ask, { answer: 'Approve' })).status, 200);
  const started = new Set<string>();
  while (started.size < 2) {
    const event = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 90_000 });
    if (event.payload.session.stage === 'implementing') started.add(event.payload.itemId);
  }
  assert.deepEqual([...started].sort(), [`${story.projectId}/ticket/home-board/01`, `${story.projectId}/ticket/home-board/02`]);
  assert.match(kiln.repo.git('show', 'main:.scratch/home-board/issues/01-draw-the-columns.md'), /\*\*What to build:\*\* One column per run state\./);
  const now = await byTitle(kiln, STORY);
  assert.equal(now.stage, 'tickets');
  assert.notEqual(now.runState, 'shipped');
});

test('the full default Workflow: an Epic ships once its Story has, and the Story once all its Tickets have', async (t) => {
  const kiln = await startTestKiln(t);
  const { epic, story, events, ask } = await atTicketsGate(kiln);
  assert.equal((await answer(kiln, ask, { answer: 'Approve' })).status, 200);

  // Each Ticket is implemented and reviewed; approving its Review Gate ships it.
  const tickets = [`${story.projectId}/ticket/home-board/01`, `${story.projectId}/ticket/home-board/02`];
  for (let approved = 0; approved < tickets.length; approved++) {
    let review: Ask;
    do review = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 120_000 })).payload.ask;
    while (review.type !== 'review' || !tickets.includes(review.itemId));
    const story0 = await byTitle(kiln, STORY);
    assert.equal(story0.stage, 'tickets', 'the Story waits while a Ticket has not shipped');
    assert.equal((await answer(kiln, review, { answer: 'Approve' })).status, 200);
  }

  await stageChange(events, story.id, 'shipped');
  await stageChange(events, epic.id, 'shipped');
  const board = await items(kiln);
  for (const id of [...tickets, story.id, epic.id]) assert.equal(board.find((i) => i.id === id)?.runState, 'shipped', id);
  assert.match(kiln.repo.git('show', 'main:.scratch/home-board/story.md'), /stage: shipped/);
  assert.match(kiln.repo.git('show', 'main:.scratch/epics/board-as-home.md'), /stage: shipped/);
  assert.equal(kiln.repo.git('show', 'main:feature.txt'), 'columns\n');
  assert.equal(kiln.repo.git('branch', '--list', 'kiln/*').trim(), '', 'every Stage branch merged and went');
  assert.equal(kiln.repo.git('worktree', 'list').trim().split('\n').length, 1, 'no worktree is left');
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks'), []);

  const sessions = await kiln.api<SessionInfo[]>('GET', '/api/sessions');
  assert.deepEqual([...new Set(sessions.map((s) => s.role))].sort(), ['griller', 'implementer', 'reviewer', 'spec-writer', 'ticket-writer']);
  for (const session of sessions) {
    assert.ok(session.worktree && session.worktree.toLowerCase() !== kiln.repo.path.toLowerCase(), `${session.role} worked in its own worktree`);
  }
});
