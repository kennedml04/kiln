import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '@kiln/widget-sdk';
import type {
  Ask,
  AuditEntry,
  EffectivePolicy,
  Item,
  KilnEvent,
  Project,
  SchedulerState,
  SessionInfo,
  SessionMessageEvent,
  ThreadEntry,
  ThreadMessageResult,
} from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type EventStream, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

type ProgressEvent = KilnEvent<'session.progress', { sessionId: string; itemId: string; text?: string }>;

async function startKiln(t: Parameters<typeof startTestKiln>[0]) {
  const knowledge = tempDir(t, 'kiln-knowledge');
  return startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: knowledge } });
}

async function projectIn(kiln: TestKiln): Promise<Project> {
  seedScratch(kiln.repo);
  return kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
}

const threadPath = (project: Project, rest: string) => `/api/projects/${encodeURIComponent(project.id)}/${rest}`;

const say = (kiln: TestKiln, project: Project, text: string) =>
  kiln.api<ThreadMessageResult>('POST', threadPath(project, 'messages'), { text });

async function progress(events: EventStream, match: RegExp, timeoutMs = 15_000): Promise<ProgressEvent> {
  for (;;) {
    const event = await events.next<ProgressEvent>('session.progress', { timeoutMs });
    if (event.payload.text && match.test(event.payload.text)) return event;
  }
}

test("a person's message in the Project Thread starts a Project Thread Session that hears it, and both show in the Project's Thread", async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const project = await projectIn(kiln);
  const events = await kiln.events();

  const first = await say(kiln, project, 'What should we do next?');

  assert.equal(first.delivery, 'fresh');
  const started = await events.next<KilnEvent<'session.started', { session: SessionInfo }>>('session.started');
  assert.equal(started.payload.session.id, first.sessionId);
  assert.equal(started.payload.session.projectId, project.id);
  assert.equal(started.payload.session.worktree, null, 'a Project Thread Session works in no worktree of its own');
  await progress(events, /^heard: What should we do next\?$/);

  const second = await say(kiln, project, 'And after that?');
  assert.deepEqual(second, { delivery: 'running', sessionId: first.sessionId });
  await progress(events, /^heard: And after that\?$/);

  const thread = await kiln.api<ThreadEntry[]>('GET', threadPath(project, 'thread'));
  const messages = thread.filter((e): e is SessionMessageEvent & ThreadEntry => e.type === 'session.message');
  assert.deepEqual(
    messages.map((m) => [m.payload.from, m.payload.text]),
    [
      ['person', 'What should we do next?'],
      ['person', 'And after that?'],
    ],
  );
  assert.ok(thread.some((e) => e.type === 'session.progress' && e.payload.text === 'heard: And after that?'));
  // The Project Thread is not an Item: the Project's Items are unchanged.
  const items = await kiln.api<{ id: string }[]>('GET', `/api/projects/${project.id}/items`);
  assert.ok(items.every((i) => i.id.startsWith(`${project.id}/`)));
});

/** The text a Kiln tool call returned, from the fake Agent's progress event for it. */
async function toolResult(events: EventStream, name: string): Promise<string> {
  for (;;) {
    const event = await events.next<KilnEvent<'session.progress', { text?: string; tool?: { name: string } }>>('session.progress', { timeoutMs: 15_000 });
    if (event.payload.tool?.name === `kiln.${name}`) return event.payload.text ?? '';
  }
}

test('a Project Thread Session reads across the Project with its Kiln tools: every Item, any Item\'s artifacts and Digests', async (t) => {
  const kiln = await startKiln(t);
  const project = await projectIn(kiln);
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  await kiln.installFakeAgent({
    script: [
      { do: 'kiln_tools_list' },
      { do: 'kiln_tool', name: 'read_project' },
      { do: 'kiln_tool', name: 'read_item', input: { itemId: ticket.id } },
      { do: 'kiln_tool', name: 'read_artifacts', input: { itemId: ticket.id, name: '.scratch/home-board/spec.md' } },
      { do: 'kiln_tool', name: 'read_digests', input: { itemId: ticket.id } },
      { do: 'kiln_tool', name: 'read_item', input: { itemId: 'elsewhere/x' } },
      { do: 'finish', reason: 'error' },
    ],
  });
  const events = await kiln.events();

  await say(kiln, project, 'Where are we?');

  const tools = await progress(events, /^tools: /);
  assert.deepEqual(
    tools.payload.text!.slice('tools: '.length).split(', ').sort(),
    ['raise_ask', 'read_artifacts', 'read_digests', 'read_item', 'read_project', 'write_digest'],
  );
  const overview = JSON.parse(await toolResult(events, 'read_project')) as { project: { id: string }; items: Item[] };
  assert.equal(overview.project.id, project.id);
  assert.deepEqual(overview.items.map((i) => i.title).sort(), items.map((i) => i.title).sort());
  const read = JSON.parse(await toolResult(events, 'read_item')) as Item;
  assert.deepEqual([read.id, read.title, read.stage], [ticket.id, 'Draw the columns', ticket.stage]);
  assert.match(await toolResult(events, 'read_artifacts'), /# Spec: Home board/);
  assert.match(await toolResult(events, 'read_digests'), /no Digests/i);
  assert.match(await toolResult(events, 'read_item'), /^error: .*elsewhere\/x/, 'an Item outside the Project is out of reach');
});

test('a Project Thread Session runs under a read-only Policy: every write it tries is denied by Policy, even one the Project allows', async (t) => {
  const kiln = await startKiln(t);
  const project = await projectIn(kiln);
  // The Project's own Policy allows this command; the Project Thread's Stage Policy still denies it.
  writeRepoFile(kiln.repo, '.kiln/policy.json', JSON.stringify({ rules: [{ action: 'other_commands', match: 'touch notes.md', decision: 'allow' }] }));
  kiln.repo.git('commit', '-q', '-am', 'Allow touch');
  await kiln.installFakeAgent({
    script: [
      { do: 'report_policy' },
      { do: 'permission', action: 'worktree_read', detail: 'README.md' },
      { do: 'permission', action: 'worktree_write', detail: 'notes.md' },
      { do: 'permission', action: 'other_commands', detail: 'touch notes.md' },
      { do: 'permission', action: 'external_writes', detail: 'git push' },
      { do: 'permission', action: 'launch_rockets', detail: 'all of them' },
      { do: 'finish', reason: 'error' },
    ],
  });
  const events = await kiln.events();

  const { sessionId } = await say(kiln, project, 'Tidy up the notes');

  const reported = await progress(events, /^policy: /);
  const policy = JSON.parse(reported.payload.text!.slice('policy: '.length)) as EffectivePolicy;
  assert.equal(policy.actions.worktree_read, 'allow');
  for (const action of ['worktree_write', 'known_commands', 'other_commands', 'network', 'external_writes', 'outside_worktree'] as const) {
    assert.equal(policy.actions[action], 'deny', action);
  }
  assert.equal(decide(policy, 'other_commands', 'touch notes.md'), 'deny');
  const decisions: string[] = [];
  for (let i = 0; i < 5; i++) decisions.push((await progress(events, /^permission /)).payload.text!);
  assert.deepEqual(decisions, ['permission allow', 'permission deny', 'permission deny', 'permission deny', 'permission deny']);

  const asks = await kiln.api<Ask[]>('GET', '/api/asks');
  assert.deepEqual(asks, [], 'nothing is left to a person: the Policy decides');
  const denied = (await kiln.api<AuditEntry[]>('GET', '/api/audit?action=permission.deny')).reverse();
  assert.deepEqual(
    denied.map((e) => [e.actor.kind, e.target, (e.detail as { action: string }).action, (e.detail as { by: string }).by, (e.detail as { sessionId: string }).sessionId]),
    [
      ['kiln', `project:${project.id}`, 'worktree_write', 'policy', sessionId],
      ['kiln', `project:${project.id}`, 'other_commands', 'policy', sessionId],
      ['kiln', `project:${project.id}`, 'external_writes', 'policy', sessionId],
      ['kiln', `project:${project.id}`, 'launch_rockets', 'policy', sessionId],
    ],
  );
});

async function nextAsk(events: EventStream): Promise<Ask> {
  return (await events.next<KilnEvent<'ask.raised', { ask: Ask }>>('ask.raised', { timeoutMs: 15_000 })).payload.ask;
}

const answer = (kiln: TestKiln, ask: Ask, text: string) => kiln.api<Ask>('POST', `/api/asks/${ask.id}/answer`, { answer: text });

test('a Project Thread Session proposes new Items as an Ask in Needs you; accepting it creates them as the person, audited', async (t) => {
  const kiln = await startKiln(t);
  const project = await projectIn(kiln);
  const before = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = before.find((i) => i.title === 'Home board')!;
  const proposal = { kind: 'create_items', items: [{ kind: 'ticket', title: 'Draw the cards', parentId: story.id }] };
  await kiln.installFakeAgent({
    script: [
      { do: 'ask', ask: { type: 'question', question: 'Add a Ticket for the cards?', why: 'Nothing draws them yet', recommendation: 'Yes', blocking: true, proposal } },
      { do: 'finish', reason: 'error' },
    ],
  });
  const events = await kiln.events();

  const { sessionId } = await say(kiln, project, 'What is missing?');

  const ask = await nextAsk(events);
  assert.deepEqual(
    [ask.type, ask.itemId, ask.projectId, ask.options, ask.recommendation, ask.blocking, ask.raisedBy],
    ['decision', `project:${project.id}`, project.id, ['Accept', 'Decline'], 'Accept', true, { kind: 'session', sessionId }],
    'a proposal is a Decision Ask to Accept or Decline',
  );
  assert.deepEqual(ask.proposal, proposal);
  assert.deepEqual((await kiln.api<Ask[]>('GET', '/api/asks')).map((a) => a.id), [ask.id], 'it lands in Needs you');
  const untouched = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.equal(untouched.length, before.length, 'proposing changes nothing');

  const accepted = await answer(kiln, ask, 'Accept');

  const after = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const created = after.find((i) => i.title === 'Draw the cards');
  assert.ok(created, 'the proposed Ticket now exists');
  assert.equal(created.parentId, story.id);
  assert.deepEqual(accepted.applied, { created: [created.id] });
  assert.equal(await progress(events, /^answered: /).then((e) => e.payload.text), 'answered: Accept');
  const applied = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=proposal.apply');
  assert.deepEqual(
    applied.map((e) => [e.actor.kind, e.target, e.outcome, e.detail]),
    [['user', `project:${project.id}`, 'allowed', { askId: ask.id, sessionId, kind: 'create_items', created: [created.id] }]],
  );
  await assert.rejects(answer(kiln, ask, 'Decline'), /409/, 'the answer to a proposal is final');
});

test('accepting a proposed Up next order reorders Up next; declining a proposal changes nothing; a malformed proposal is refused', async (t) => {
  const kiln = await startKiln(t);
  const project = await projectIn(kiln);
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = items.find((i) => i.title === 'Home board')!;
  await kiln.api('PUT', '/api/scheduler/pools/agents', { size: 0 });
  const tickets: Item[] = [];
  for (const title of ['B', 'C']) {
    // Up next is ordered by Story, so each Ticket gets a Story of its own.
    const own = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'story', title: `Story ${title}` });
    const ticket = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: own.id });
    await kiln.api('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
    tickets.push(ticket);
  }
  const [b, c] = tickets as [Item, Item];
  const ask = (question: string, proposal: unknown) => ({
    type: 'decision', question, why: 'It matters', recommendation: 'Accept', blocking: false, proposal,
  });
  await kiln.installFakeAgent({
    script: [
      { do: 'kiln_tool', name: 'raise_ask', input: ask('Delete it all?', { kind: 'delete_everything' }) },
      { do: 'ask', ask: ask('Do C before B?', { kind: 'reorder_queue', order: [c.id, b.id] }) },
      { do: 'ask', ask: ask('Add a Ticket?', { kind: 'create_items', items: [{ kind: 'ticket', title: 'Unwanted', parentId: story.id }] }) },
      { do: 'wait_for_message' },
    ],
  });
  const events = await kiln.events();

  await say(kiln, project, 'Plan the week');

  assert.match(await toolResult(events, 'raise_ask'), /^error: .*proposal/i);
  const reorder = await nextAsk(events);
  const create = await nextAsk(events);
  const queue = async () => (await kiln.api<SchedulerState>('GET', '/api/scheduler')).queue.map((q) => q.itemId);
  assert.deepEqual(await queue(), [b.id, c.id], 'proposing changes nothing');

  const accepted = await answer(kiln, reorder, 'Accept');
  assert.deepEqual(await queue(), [c.id, b.id]);
  assert.deepEqual(accepted.applied, { order: [c.id, b.id] });

  const declined = await answer(kiln, create, 'Decline');
  assert.equal(declined.applied, undefined);
  const after = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.ok(!after.some((i) => i.title === 'Unwanted'), 'a declined proposal is not applied');
  await assert.rejects(answer(kiln, create, 'Accept'), /409/, 'not even when the answer would change');
  const applied = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=proposal.apply');
  assert.deepEqual(applied.map((e) => (e.detail as { kind: string }).kind), ['reorder_queue']);
});
