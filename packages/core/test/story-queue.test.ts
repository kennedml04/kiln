// Story slots, Blocked by and parking in the scheduler's dispatch, seen through GET /api/scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, Item, Project, SchedulerState, SessionStartedEvent, StartResult } from '@kiln/widget-sdk';
import { createTempRepo, startTestKiln, type EventStream, type FakeAgentScripts, type TempRepo, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';

type Spec = Record<string, [number, string, string?][]>;

/** Writes Stories at the Tickets Stage with their Tickets `[number, title, blockedBy?]` and commits. */
function seed(repo: TempRepo, stories: Spec) {
  for (const [slug, tickets] of Object.entries(stories)) {
    writeRepoFile(repo, `.scratch/${slug}/story.md`, `---\ntitle: ${slug}\nstage: tickets\n---\n\nWhy ${slug}.\n`);
    for (const [n, title, blockedBy] of tickets) {
      const nn = String(n).padStart(2, '0');
      const slugged = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      writeRepoFile(
        repo,
        `.scratch/${slug}/issues/${nn}-${slugged}.md`,
        `# ${nn}: ${title}\n\n**What to build:** ${title}.\n\n**Blocked by:** ${blockedBy ?? 'None'}\n\n**Status:** ready-for-agent\n`,
      );
    }
  }
  writeRepoFile(repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'Seed');
}

/** Finishes at once: commits a file named for the Ticket, so it reaches its Review Gate. */
const quick = (name: string) => [
  { do: 'write' as const, path: `${name}.txt`, content: `${name}\n` },
  { do: 'commit' as const, message: name },
];
const WAIT = [{ do: 'wait_for_message' as const }];
const reviewer = (path: string) => [
  { do: 'write' as const, path, content: '# Review\n\nFine.\n' },
  { do: 'commit' as const, message: 'Review findings' },
];

async function boot(t: Parameters<typeof startTestKiln>[0], stories: Spec, script: FakeAgentScripts = WAIT) {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script });
  seed(kiln.repo, stories);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = (title: string) => items.find((i) => i.kind === 'ticket' && i.title === title)!;
  return { kiln, agent, project, ticket, events: await kiln.events() };
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);
const sched = (kiln: TestKiln) => kiln.api<SchedulerState>('GET', '/api/scheduler');
const held = async (kiln: TestKiln, item: Item) => (await sched(kiln)).queue.find((e) => e.itemId === item.id)?.held;
const runState = async (kiln: TestKiln, item: Item) =>
  (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === item.id)!.runState;

const reviewAskOf = async (events: EventStream, itemId: string): Promise<Ask> => {
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === 'review' && raised.payload.itemId === itemId) return raised.payload.ask;
  }
};
const startedItem = async (events: EventStream, itemId: string) => {
  for (;;) {
    const e = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 30_000 });
    if (e.payload.itemId === itemId) return e;
  }
};
const approve = (kiln: TestKiln, ask: Ask) =>
  kiln.api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
/** Polls until `check` holds (derived state settling after an event). */
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('with the limit at 2 no Ticket of a third Story starts until one of the first two ships, though the pool has room', async (t) => {
  const { kiln, agent, project, ticket, events } = await boot(
    t,
    { alpha: [[1, 'Alpha one']], beta: [[1, 'Beta one']], gamma: [[1, 'Gamma one']] },
    {
      'implementer@Alpha one': [{ do: 'wait_for_message' }, ...quick('alpha')],
      implementer: WAIT,
      reviewer: reviewer('.scratch/alpha/reviews/01-alpha-one.md'),
    },
  );
  const [a, b, c] = [ticket('Alpha one'), ticket('Beta one'), ticket('Gamma one')] as [Item, Item, Item];
  const first = await start(kiln, a);
  await start(kiln, b);
  const third = await start(kiln, c);

  assert.equal(third.queued, true);
  const state = await sched(kiln);
  assert.equal(state.pools[0]!.size, 3);
  assert.equal(state.pools[0]!.active, 2);
  assert.equal(await held(kiln, c), 'Waiting for a Story slot');
  assert.deepEqual(state.limits, { perProject: { [project.id]: 2 }, boxWide: 3 });
  assert.deepEqual(
    state.stories.map((s) => [s.inFlight, s.started, s.shipped, s.total]),
    [[true, true, 0, 1], [true, true, 0, 1], [false, false, 0, 1]],
  );
  assert.equal(state.stories[2]!.next, c.id);

  // Alpha finishes, passes review and ships: Gamma takes its place.
  await agent.sendMessage(first.session!.id, { kind: 'text', text: 'go' });
  await approve(kiln, await reviewAskOf(events, a.id));
  await startedItem(events, c.id);
  assert.equal(await runState(kiln, c), 'running');
});

test('two Projects limited to 2 each with the agents pool at 2 never have more than 2 Stories in flight', async (t) => {
  const { kiln, agent, project, ticket } = await boot(t, { s1: [[1, 'S one']], s2: [[1, 'S two']] });
  const repoB = createTempRepo(t);
  seed(repoB, { t1: [[1, 'T one']], t2: [[1, 'T two']] });
  const projectB = await kiln.api<Project>('POST', '/api/projects', { path: repoB.path });
  const itemsB = await kiln.api<Item[]>('GET', `/api/projects/${projectB.id}/items`);
  const tb = (title: string) => itemsB.find((i) => i.kind === 'ticket' && i.title === title)!;
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 2 });
  const results: StartResult[] = [];
  for (const item of [ticket('S one'), ticket('S two'), tb('T one'), tb('T two')]) results.push(await start(kiln, item));

  assert.deepEqual(results.map((r) => r.queued), [false, false, true, true]);
  // One Session ends, freeing a pool slot, but its Story is still in flight: nothing new starts.
  await agent.stopSession(results[0]!.session!.id);
  await until(async () => (await sched(kiln)).pools[0]!.active === 1, 'the pool slot to free');
  const state = await sched(kiln);
  assert.equal(state.stories.filter((s) => s.inFlight).length, 2);
  assert.deepEqual(state.queue.map((e) => e.held), ['Waiting for a Story slot', 'Waiting for a Story slot']);
  assert.notEqual(project.id, projectB.id);
  assert.equal(state.limits.perProject[projectB.id], 2);
});

test('Blocked by holds a Ticket until its blockers ship; one Story never holds more of the pool than size - 1', async (t) => {
  const { kiln, agent, ticket, events } = await boot(
    t,
    { alpha: [[1, 'One'], [2, 'Two', '01'], [3, 'Three']] },
    {
      'implementer@One': [{ do: 'wait_for_message' }, ...quick('one')],
      implementer: WAIT,
      reviewer: reviewer('.scratch/alpha/reviews/01-one.md'),
    },
  );
  const [one, two, three] = [ticket('One'), ticket('Two'), ticket('Three')] as [Item, Item, Item];
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 2 });
  const first = await start(kiln, one);
  await start(kiln, two);
  await start(kiln, three);

  assert.equal(await held(kiln, two), 'Blocked by 01');
  assert.equal(await held(kiln, three), 'Story already holds its share of the pool');

  // With three slots the Story may hold two: Three runs beside One; Two stays blocked.
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 3 });
  await startedItem(events, three.id);
  assert.equal(await held(kiln, two), 'Blocked by 01');
  assert.equal((await sched(kiln)).pools[0]!.active, 2);

  await agent.sendMessage(first.session!.id, { kind: 'text', text: 'go' });
  await approve(kiln, await reviewAskOf(events, one.id));
  await startedItem(events, two.id);
});

test('a Story whose only open Ticket reaches its Gate is parked: the next Story starts, and the parked one goes ahead of one not started', async (t) => {
  const { kiln, ticket, events } = await boot(
    t,
    { alpha: [[1, 'A one'], [2, 'A two', '01']], beta: [[1, 'B one']], gamma: [[1, 'C one']] },
    {
      'implementer@A one': quick('a1'),
      implementer: WAIT,
      reviewer: reviewer('.scratch/alpha/reviews/01-a-one.md'),
    },
  );
  const [a1, a2, b1, c1] = [ticket('A one'), ticket('A two'), ticket('B one'), ticket('C one')] as [Item, Item, Item, Item];
  await kiln.api('PUT', `/api/scheduler/story-limits/${encodeURIComponent(a1.projectId)}`, { limit: 1 });
  await start(kiln, a1);
  const gate = await reviewAskOf(events, a1.id);
  await start(kiln, a2);
  await start(kiln, b1);
  await start(kiln, c1);

  // Alpha waits on the person (A two waits on A one): Beta takes the slot, Gamma waits.
  await startedItem(events, b1.id);
  const parked = await sched(kiln);
  assert.deepEqual(parked.stories.map((s) => [s.parked, s.inFlight]), [[true, false], [false, true], [false, false]]);
  assert.equal(await held(kiln, c1), 'Waiting for a Story slot');
  assert.equal(await held(kiln, a2), 'Blocked by 01');

  // Approving the Gate lets A two go ahead of Gamma, which has not started.
  await approve(kiln, gate);
  await startedItem(events, a2.id);
  assert.equal(await held(kiln, c1), 'Waiting for a Story slot');
});

test("a Ticket blocked only by another Story's Ticket parks its Story instead of holding the slot", async (t) => {
  const { kiln, ticket, events } = await boot(
    t,
    { alpha: [[1, 'A one'], [2, 'A two', 'beta/01']], beta: [[1, 'B one']] },
    { 'implementer@A one': quick('a1'), implementer: WAIT, reviewer: reviewer('.scratch/alpha/reviews/01-a-one.md') },
  );
  const [a1, a2, b1] = [ticket('A one'), ticket('A two'), ticket('B one')] as [Item, Item, Item];
  await kiln.api('PUT', `/api/scheduler/story-limits/${encodeURIComponent(a1.projectId)}`, { limit: 1 });
  await start(kiln, a1);
  await reviewAskOf(events, a1.id);
  await start(kiln, a2);
  assert.equal(await held(kiln, a2), 'Blocked by beta/01');

  const result = await start(kiln, b1);

  assert.equal(result.queued, false);
  const state = await sched(kiln);
  assert.equal(state.stories.find((s) => s.storyId === a1.parentId)!.parked, true);
});

test('Stories in flight is a whole number from 0 to 10 that an Admin sets; raising it starts held Tickets', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.installFakeAgent({ script: WAIT });
  seed(kiln.repo, { alpha: [[1, 'Alpha one']], beta: [[1, 'Beta one']] });
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const path = `/api/scheduler/story-limits/${encodeURIComponent(project.id)}`;
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  assert.equal((await sched(kiln)).limits.perProject[project.id], 2);
  assert.equal((await kiln.as('mo').request('PUT', path, { limit: 1 })).status, 403);
  assert.equal((await kiln.request('PUT', path, { limit: 11 })).status, 400);
  assert.equal((await kiln.request('PUT', path, { limit: 1.5 })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/scheduler/story-limits/nope', { limit: 1 })).status, 404);

  await kiln.api('PUT', path, { limit: 0 });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const beta = items.find((i) => i.title === 'Beta one')!;
  assert.equal((await start(kiln, beta)).queued, true);
  assert.equal(await held(kiln, beta), 'Waiting for a Story slot');

  const raised = await kiln.api<SchedulerState>('PUT', path, { limit: 1 });
  assert.equal(raised.limits.perProject[project.id], 1);
  assert.deepEqual(raised.queue, []);
});
