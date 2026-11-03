import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ExitCheckedEvent,
  Item,
  ItemStageChangedEvent,
  Project,
  SessionInfo,
  SessionMessageEvent,
  SessionStalledEvent,
  StartResult,
  ThreadEntry,
} from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}" in ${items.map((i) => i.title).join(', ')}`);
  return item;
};

const samePath = (a: string, b: string) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();

async function registerSeeded(kiln: TestKiln): Promise<{ project: Project; items: Item[] }> {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  return { project, items };
}

const start = async (kiln: TestKiln, item: Item): Promise<SessionInfo> =>
  (await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`)).session!;

test('a Ticket entering Implementing gets its own worktree and branch, and its Session works only there', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'commit', message: 'Draw the columns' },
    ],
  });
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');
  const mainBefore = kiln.repo.git('rev-parse', 'main').trim();
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  await events.next('session.finished', { timeoutMs: 15_000 });

  assert.equal(session.itemId, ticket.id);
  assert.equal(session.stage, 'implementing');
  assert.ok(!samePath(session.worktree!, kiln.repo.path), 'the Session must not run in the main checkout');
  assert.ok(existsSync(join(session.worktree!, 'feature.txt')));
  assert.ok(!existsSync(join(kiln.repo.path, 'feature.txt')), 'the main checkout is untouched');
  assert.equal(kiln.repo.git('status', '--porcelain'), '');
  assert.equal(kiln.repo.git('rev-parse', 'main').trim(), mainBefore);
  assert.equal(kiln.repo.git('log', '-1', '--format=%s', session.branch!).trim(), 'Draw the columns');
  const worktrees = kiln.repo.git('worktree', 'list', '--porcelain');
  assert.ok(
    worktrees.split('\n').some((line) => line.startsWith('worktree ') && samePath(line.slice(9), session.worktree!)),
    worktrees,
  );
  const item = byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns');
  assert.equal(item.run?.branch, session.branch);
  assert.equal(item.run?.sessionId, session.id);
});

/** A Project whose tests pass only when `answer.txt` says 42. */
function addAnswerTests(kiln: TestKiln) {
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node check-answer.mjs' }));
  writeRepoFile(
    kiln.repo,
    'check-answer.mjs',
    "import { readFileSync } from 'node:fs';\nconst answer = readFileSync('answer.txt', 'utf8').trim();\nif (answer !== '42') {\n  console.error(`expected 42, got ${answer}`);\n  process.exit(1);\n}\n",
  );
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the answer tests');
}

test('failing tests go back to the Session as feedback; once they pass the Ticket moves to Review in a Kiln commit touching only Stage and Status', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: 'answer.txt', content: '41\n' },
        { do: 'commit', message: 'Answer' },
        { do: 'finish', message: 'Done.' },
        { do: 'write', path: 'answer.txt', content: '42\n' },
        { do: 'commit', message: 'Fix the answer' },
      ],
      // Entering Review starts the review Session; here it does nothing.
      reviewer: [],
    },
  });
  seedScratch(kiln.repo);
  addAnswerTests(kiln);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), 'Draw the columns');
  const ticketFile = '.scratch/home-board/issues/01-draw-the-columns.md';
  const before = readRepoFile(kiln.repo, ticketFile);
  const headBefore = kiln.repo.git('rev-parse', 'HEAD').trim();
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const first = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.deepEqual(first.payload.exit.checks.map((c) => [c.id, c.met]), [
    ['branch_has_commits', true],
    ['tree_clean', true],
    ['tests_pass', false],
  ]);
  assert.match(first.payload.exit.checks[2]!.detail!, /expected 42, got 41/);
  const feedback = await events.next<SessionMessageEvent>('session.message');
  assert.match(feedback.payload.text, /expected 42, got 41/);
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns').stage, 'implementing');

  const second = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(second.payload.exit.met, true);
  const moved = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 15_000 });
  assert.deepEqual([moved.payload.itemId, moved.payload.from, moved.payload.to], [ticket.id, 'implementing', 'review']);

  const item = byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns');
  assert.equal(item.stage, 'review');
  assert.equal(item.status, 'in-review');
  assert.equal(item.run?.exit?.met, true);
  assert.equal(kiln.repo.git('rev-parse', 'HEAD~1').trim(), headBefore, 'exactly one new commit on main');
  assert.equal(kiln.repo.git('log', '-1', '--format=%an <%ae>').trim(), 'Kiln <kiln@localhost>');
  assert.equal(kiln.repo.git('show', '--name-only', '--format=', 'HEAD').trim(), ticketFile);
  const changed = kiln.repo
    .git('diff', '--unified=0', 'HEAD~1', 'HEAD')
    .split('\n')
    .filter((line) => /^[+-](?![+-])/.test(line) && line.trim().length > 1);
  assert.deepEqual(changed, ['-**Status:** ready-for-agent', '+**Status:** in-review', '+**Stage:** review']);
  assert.equal(
    readRepoFile(kiln.repo, ticketFile),
    before.replace('**Status:** ready-for-agent\n', '**Status:** in-review\n\n**Stage:** review\n'),
  );
  assert.equal(kiln.repo.git('status', '--porcelain'), '');
  assert.ok(!existsSync(join(kiln.repo.path, 'answer.txt')), 'the main checkout never gets the work');
  assert.equal(kiln.repo.git('show', `${session.branch}:answer.txt`).trim(), '42');
});

test('two Tickets in Implementing at once get separate worktrees and never see each other\'s changes', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'write', path: 'work/{session}.txt', content: 'mine\n' },
      { do: 'tool', name: 'think', times: 10, intervalMs: 100 },
      { do: 'commit', message: 'Work for {session}' },
    ],
  });
  const { project, items } = await registerSeeded(kiln);
  const story = byTitle(items, 'Home board');
  const first = byTitle(items, 'Draw the columns');
  const second = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, {
    kind: 'ticket',
    title: 'Colour the columns',
    parentId: story.id,
  });
  const events = await kiln.events();

  const [a, b] = await Promise.all([start(kiln, first), start(kiln, second)]);
  const running = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.deepEqual(
    [byTitle(running, 'Draw the columns').runState, byTitle(running, 'Colour the columns').runState],
    ['running', 'running'],
  );
  await events.next('session.finished', { timeoutMs: 15_000 });
  await events.next('session.finished', { timeoutMs: 15_000 });

  assert.notEqual(a.branch, b.branch);
  assert.ok(!samePath(a.worktree!, b.worktree!));
  const files = (session: SessionInfo) =>
    kiln.repo.git('ls-tree', '-r', '--name-only', session.branch!, 'work/').trim().split('\n');
  assert.deepEqual(files(a), [`work/${a.id}.txt`]);
  assert.deepEqual(files(b), [`work/${b.id}.txt`]);
  assert.ok(!existsSync(join(a.worktree!, 'work', `${b.id}.txt`)));
  assert.ok(!existsSync(join(b.worktree!, 'work', `${a.id}.txt`)));
  assert.ok(!existsSync(join(kiln.repo.path, 'work')));
});

test('the Session is seeded with the Ticket and its Story\'s spec, and the Item\'s Thread records it in order', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'progress', text: 'seeded with {seed}' }] });
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  await events.next('exit.checked', { timeoutMs: 15_000 });
  await events.next('session.message');

  const thread = await kiln.api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`);
  assert.deepEqual(thread.map((e) => e.type), [
    'session.started',
    'session.progress',
    'session.finished',
    'exit.checked',
    'session.updated',
    'session.message',
  ]);
  assert.ok(thread.every((e) => e.payload.sessionId === session.id && e.payload.itemId === ticket.id));
  assert.equal(
    thread[1]!.payload.text,
    'seeded with .scratch/home-board/issues/01-draw-the-columns.md, .scratch/home-board/story.md, .scratch/home-board/spec.md',
  );
});

test('a Stage starts no Session without a ready Agent, and an Item runs one Session at a time', async (t) => {
  const kiln = await startTestKiln(t);
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');

  await assert.rejects(start(kiln, ticket), /409.*No Agent is ready/);
  await assert.rejects(start(kiln, byTitle(items, 'Board as home')), /409.*runs no Session/);

  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  await start(kiln, ticket);
  await assert.rejects(start(kiln, ticket), /409.*already has a running Session/);
});

test('an Agent saying it is done does not meet the Exit: Kiln checks commits, a clean tree and tests itself', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'write', path: 'feature.txt', content: 'columns\n' },
      { do: 'finish', message: 'All done! Everything is committed and the tests pass.' },
    ],
  });
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');
  const events = await kiln.events();

  await start(kiln, ticket);
  const checked = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  const feedback = await events.next<SessionMessageEvent>('session.message');

  assert.equal(checked.payload.itemId, ticket.id);
  assert.equal(checked.payload.exit.met, false);
  assert.deepEqual(
    checked.payload.exit.checks.map((c) => [c.id, c.met]),
    [
      ['branch_has_commits', false],
      ['tree_clean', false],
      ['tests_pass', false],
    ],
  );
  assert.equal(feedback.payload.from, 'kiln');
  assert.match(feedback.payload.text, /Working tree clean/);
  assert.match(feedback.payload.text, /No testCommand in \.kiln\/settings\.json/);
  const item = byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns');
  assert.equal(item.stage, 'implementing');
  assert.equal(item.runState, 'running');
  assert.deepEqual(item.run?.exit?.checks.filter((c) => !c.met).map((c) => c.name), [
    'Branch has commits',
    'Working tree clean',
    'Tests pass',
  ]);
});

const stoppedMessage = async (events: Awaited<ReturnType<TestKiln['events']>>) => {
  for (;;) {
    const message = await events.next<SessionMessageEvent>('session.message', { timeoutMs: 15_000 });
    if (message.payload.text.startsWith('Kiln stopped this Session')) return message.payload.text;
  }
};

test('a Session whose Agent goes quiet after Exit feedback is stopped, not left running for ever', async (t) => {
  const kiln = await startTestKiln(t, { env: { KILN_EXIT_IDLE_MS: '300' } });
  // The script ends at once, so the Agent never acts on the feedback.
  await kiln.installFakeAgent({ script: [] });
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  assert.match(await stoppedMessage(events), /did nothing/);
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'stopped');
  assert.equal(byTitle(await kiln.api<Item[]>('GET', '/api/items'), 'Draw the columns').runState, 'backlog');
});

test('a Session that keeps finishing without meeting its Exit falls under the stall rule: 8 unmet rounds pause it behind an Ask', async (t) => {
  const kiln = await startTestKiln(t);
  const finish = { do: 'finish', message: 'Done.' } as const;
  await kiln.installFakeAgent({ script: Array.from({ length: 12 }, () => finish) });
  const { items } = await registerSeeded(kiln);
  const ticket = byTitle(items, 'Draw the columns');
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const stalled = await events.next<SessionStalledEvent>('session.stalled', { timeoutMs: 20_000 });

  assert.equal(stalled.payload.sessionId, session.id);
  const exits = (await kiln.api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`)).filter((e) => e.type === 'exit.checked');
  assert.equal(exits.length, 8, 'one rule: the stall rule\'s 8 turns, not a separate cap on Exit rounds');
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'waiting', 'paused behind the stall Ask, nothing killed');
});
