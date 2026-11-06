// The Permission review: after a Ticket merges, one Decision Ask proposes Policy rules for the
// Permission Asks its Sessions raised and a person always allowed, and warns about kills by name.
// Nothing changes until it is answered; the rules chosen are one Policy commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, Item, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';

type Events = Awaited<ReturnType<TestKiln['events']>>;

const ANSWERS: Record<string, string> = {
  'git checkout -q feature/a': 'Allow once',
  'git checkout -q feature/b': 'Allow once',
  'taskkill //F //IM vite.exe': 'Allow once',
  'make build': 'Allow once',
  'rm -rf dist': 'Allow once',
  'npm run lint': 'Deny',
};

/** Answers each Permission Ask as ANSWERS says, until the Review Ask comes up; then the Permission review's Ask after the merge. */
async function shipTicket(kiln: TestKiln, events: Events): Promise<Ask> {
  for (;;) {
    const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 })).payload;
    if (ask.type === 'permission') {
      await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: ANSWERS[ask.permission!.detail] });
    } else if (ask.type === 'review') {
      await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Approve' });
    } else if (ask.raisedBy.kind === 'permission_review') {
      return ask;
    }
  }
}

test('after a Ticket merges, one Decision Ask proposes rules for what was always allowed, and applies only the ones chosen', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        ...Object.keys(ANSWERS).map((detail) => ({ do: 'permission' as const, action: 'other_commands', detail })),
        { do: 'write', path: 'feature.txt', content: 'columns\n' },
        { do: 'commit', message: 'Draw the columns' },
        { do: 'finish', message: 'Done.' },
      ],
      reviewer: [
        { do: 'write', path: FINDINGS, content: '# Review\n\nLooks good.\n' },
        { do: 'commit', message: 'Review findings' },
      ],
    },
  });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the tests');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);

  const ask = await shipTicket(kiln, events);
  assert.equal(ask.type, 'decision');
  assert.equal(ask.blocking, false);
  assert.equal(ask.itemId, ticket.id);
  assert.deepEqual(ask.options, ['Apply all', 'Apply some', 'Skip all']);
  // Denied (npm run lint), one-off (rm -rf dist) and kill-by-name requests are not proposed.
  assert.deepEqual(
    ask.permissionReview!.rules.map((r) => [r.match, r.asks]),
    [
      ['git checkout -q *', 2],
      ['make *', 1],
    ],
  );
  assert.equal(ask.permissionReview!.warnings.length, 1, ask.permissionReview!.warnings.join('\n'));
  assert.match(ask.permissionReview!.warnings[0]!, /taskkill \/\/F \/\/IM vite\.exe.*by image name/);
  assert.match(ask.why, /1\. git checkout -q \* /);
  assert.match(ask.why, /Warning: /);
  const before = kiln.repo.git('rev-parse', 'main').trim();
  assert.deepEqual(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules, [], 'nothing changes before the answer');

  const unnamed = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Apply some', comment: 'the first' });
  assert.equal(unnamed.status, 400, 'Apply some names its rules');
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Apply some', comment: '1' });
  assert.deepEqual(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules, [
    { action: 'other_commands', match: 'git checkout -q *', decision: 'allow' },
  ]);
  assert.equal(kiln.repo.git('rev-parse', 'main~1').trim(), before, 'one commit');
  assert.equal(kiln.repo.git('log', '-1', '--format=%an|%s', 'main').trim(), 'Kiln|Kiln: Permission review allows one command shape');
  assert.equal(kiln.repo.git('show', '--name-only', '--format=', 'main').trim(), '.kiln/policy.json');

  const again = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Apply all' });
  assert.equal(again.status, 409, 'applied once');
  assert.equal(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules.length, 1);
});
