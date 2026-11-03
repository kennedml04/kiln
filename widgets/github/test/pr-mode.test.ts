// PR mode: a Project with `mergeMode: "pr"` ships a Ticket through a pull request instead of a local
// merge. The remote is a local bare repo and GitHub is the fake, so nothing leaves this PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { Ask, AskRaisedEvent, CoreStatus, Item, ItemStageChangedEvent, KilnEvent, StartResult, WidgetInfo } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';
import { startFakeGitHub, type FakeGitHub } from '@kiln/testing/fake-github';
import { CONTRACT_TREE } from '@kiln/testing/tracker-contract';
import { byTitle, registerGitHubProject, seedIssues, startGitHubWidget } from './helpers.ts';

const BRANCH = 'kiln/ticket/3';
const FINDINGS = '.scratch/reviews/ticket-3.md';

/** A bare repo standing in for the GitHub remote, added to the test repo as `origin`. */
function bareRemote(t: Cleanup, kiln: TestKiln): string {
  const bare = tempDir(t, 'kiln-remote');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  kiln.repo.git('remote', 'add', 'origin', bare);
  return bare;
}
const remoteBranches = (bare: string) => execFileSync('git', ['--git-dir', bare, 'branch', '--list'], { encoding: 'utf8' });

type Events = Awaited<ReturnType<TestKiln['events']>>;
async function nextAsk(events: Events, type: Ask['type']): Promise<Ask> {
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === type) return raised.payload.ask;
  }
}
const answer = (kiln: TestKiln, ask: Ask, value: string) => kiln.api<Ask>('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: value });

/** A PR-mode GitHub Project whose ready Ticket has been implemented and reviewed, at its Gate. */
async function atGate(t: Cleanup, options: { settings?: Record<string, unknown>; policy?: unknown } = {}) {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'progress', text: 'closed note: {artifact:Pull request closed}' },
        { do: 'write', path: 'feature.txt', content: 'columns\n' },
        { do: 'commit', message: 'Draw the columns' },
      ],
      reviewer: [
        { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good.\n' },
        { do: 'commit', message: 'Review findings' },
      ],
    },
  });
  const fake: FakeGitHub = await startFakeGitHub(t);
  const issues = seedIssues(fake);
  await startGitHubWidget(t, kiln, { apiUrl: fake.url, token: fake.token });
  const bare = bareRemote(t, kiln);
  if (options.policy) writeRepoFile(kiln.repo, '.kiln/policy.json', JSON.stringify(options.policy));
  const project = await registerGitHubProject(kiln, fake.repo, { mergeMode: 'pr', ...options.settings });
  const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.ready);
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const review = await nextAsk(events, 'review');
  return { kiln, fake, issues, bare, ticket, events, review };
}

test('in PR mode, approving the Gate asks before pushing, then opens a pull request; merging it on GitHub ships the Ticket', { timeout: 120_000 }, async (t) => {
  const { kiln, fake, issues, bare, ticket, events, review } = await atGate(t);

  await answer(kiln, review, 'Approve');
  const permission = await nextAsk(events, 'permission');
  assert.equal(permission.itemId, ticket.id);
  assert.equal(permission.blocking, true);
  assert.match(permission.question, /git push origin kiln\/ticket\/3/);
  assert.equal(fake.pulls().length, 0, 'nothing is pushed or proposed before the person answers');
  assert.equal(remoteBranches(bare).trim(), '');

  await answer(kiln, permission, 'Allow once');
  await events.next('item.pr_opened', { timeoutMs: 30_000 });
  assert.match(remoteBranches(bare), /kiln\/ticket\/3/);
  const [pull] = fake.pulls();
  assert.deepEqual([pull?.head, pull?.base, pull?.title], [BRANCH, 'main', CONTRACT_TREE.ready]);
  const waiting = byTitle(await kiln.api<Item[]>('GET', '/api/items'), CONTRACT_TREE.ready);
  assert.equal(waiting.stage, 'review', 'the Ticket waits at its Gate until the pull request merges');
  assert.equal(kiln.repo.git('branch', '--list', 'main').trim().length > 0, true);
  assert.throws(() => kiln.repo.git('show', 'main:feature.txt'), 'nothing was merged locally');

  fake.mergePull(pull!.number);
  let shipped: ItemStageChangedEvent;
  do shipped = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 30_000 });
  while (shipped.payload.itemId !== ticket.id || shipped.payload.from !== 'review');
  assert.equal(shipped.payload.to, 'shipped');
  const issue = fake.issue(issues.ready.number);
  assert.equal(issue.state, 'closed');
  assert.ok(issue.labels.includes('stage:shipped'));

  const audit = await kiln.api<Array<{ action: string; outcome: string }>>('GET', '/api/audit');
  assert.ok(audit.some((e) => e.action === 'pr.open' && e.outcome === 'allowed'), 'opening the pull request is audited');
});

/** Approves the Gate and allows the push: the pull request is open and the Ticket waits for it. */
async function withOpenPullRequest(t: Cleanup) {
  const gate = await atGate(t);
  await answer(gate.kiln, gate.review, 'Approve');
  await answer(gate.kiln, await nextAsk(gate.events, 'permission'), 'Allow once');
  await gate.events.next('item.pr_opened', { timeoutMs: 30_000 });
  return { ...gate, pull: gate.fake.pulls()[0]! };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const ticketNow = async (kiln: TestKiln) => byTitle(await kiln.api<Item[]>('GET', '/api/items'), CONTRACT_TREE.ready);

test('after a core restart, a Ticket with an open pull request still waits at its Gate, and merging it still ships it', { timeout: 120_000 }, async (t) => {
  const { kiln, fake, events, pull } = await withOpenPullRequest(t);
  events.close();
  const before = await kiln.api<CoreStatus>('GET', '/api/status');

  await kiln.request('POST', '/api/core/restart-when-idle');
  await eventually('the restarted core', async () => ((await kiln.api<CoreStatus>('GET', '/api/status')).pid !== before.pid ? true : undefined));
  await eventually('the GitHub Widget to be ready again', async () =>
    (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === 'github' && w.state === 'ready'),
  );

  // Tests keep secrets in the core's memory, so the restarted core needs the token again.
  await kiln.api('PUT', '/api/widgets/github/secrets/github-token', { value: fake.token });
  const waiting = await eventually('the Ticket to be read again', () => ticketNow(kiln));
  assert.deepEqual([waiting.stage, waiting.runState], ['review', 'waiting'], 'the open pull request still holds the Ticket at its Gate');
  fake.mergePull(pull.number);
  const shipped = await eventually('the Ticket to ship', async () => ((await ticketNow(kiln)).stage === 'shipped' ? true : undefined));
  assert.equal(shipped, true);
});

test('a pull request closed on GitHub without merging sends the Ticket back to rework, with a note saying so', { timeout: 120_000 }, async (t) => {
  const { kiln, fake, ticket, events, pull } = await withOpenPullRequest(t);

  fake.closePull(pull.number);
  let back: ItemStageChangedEvent;
  do back = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 30_000 });
  while (back.payload.itemId !== ticket.id || back.payload.from !== 'review');
  assert.equal(back.payload.to, 'implementing');

  // The first implementer Session reported "(none)"; the rework Session is seeded with the note.
  let note: KilnEvent<'session.progress', { text?: string }>;
  do note = await events.next<KilnEvent<'session.progress', { text?: string }>>('session.progress', { timeoutMs: 30_000 });
  while (!/^closed note: (?!\(none\))/.test(note.payload.text ?? ''));
  assert.match(note.payload.text!, new RegExp(`Pull request #${pull.number} was closed on GitHub without merging`));
});

test('a local-only Project never pushes: the Policy denies the pull request and the Gate asks again', { timeout: 120_000 }, async (t) => {
  const { kiln, fake, bare, events, review } = await atGate(t, { settings: { localOnly: true } });

  await answer(kiln, review, 'Approve');
  const failed = await events.next<KilnEvent<'gate.failed', { error: string }>>('gate.failed', { timeoutMs: 30_000 });
  assert.match(failed.payload.error, /Policy/);
  const again = await nextAsk(events, 'review');
  assert.match(again.why, /Policy/);
  assert.equal(fake.pulls().length, 0);
  assert.equal(remoteBranches(bare).trim(), '');
});

test('a Policy rule that allows the push and the pull request opens it without asking', { timeout: 120_000 }, async (t) => {
  const { kiln, fake, events, review } = await atGate(t, {
    policy: {
      actions: { other_commands: 'ask', network: 'ask', external_writes: 'ask' },
      rules: [
        { action: 'external_writes', match: 'git push origin *', decision: 'allow' },
        { action: 'external_writes', match: 'github pr *', decision: 'allow' },
      ],
    },
  });

  await answer(kiln, review, 'Approve');
  await events.next('item.pr_opened', { timeoutMs: 30_000 });
  assert.equal(fake.pulls().length, 1);
  assert.deepEqual((await kiln.api<Ask[]>('GET', '/api/asks')).filter((a) => a.type === 'permission'), []);
});
