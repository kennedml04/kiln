// A Project's Kiln files in its repo's `.kiln` folder: a custom Workflow and the Project settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask, AskRaisedEvent, ExitCheckedEvent, Item, ItemUpdatedEvent, Project, ProjectUpdatedEvent, StartResult, Workflow } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';

/** A bug-fixing Workflow: one Item kind, a Fix Stage that is also its Gate, then Closed. */
const BUGS: Workflow = {
  name: 'bugs',
  kinds: [
    {
      id: 'bug',
      name: 'Bug',
      stages: [
        {
          id: 'fix',
          name: 'Fix',
          role: 'fixer',
          agent: 'fake',
          model: 'fake-small',
          worktree: true,
          exit: ['branch_has_commits'],
          gate: true,
          rework: 'fix',
        },
        { id: 'closed', name: 'Closed' },
      ],
    },
  ],
};

/** Writes a `.kiln` file into the repo and commits it. */
function commitKilnFile(kiln: TestKiln, name: string, content: unknown) {
  writeRepoFile(kiln.repo, `.kiln/${name}`, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', `Kiln ${name}`);
}

const register = (kiln: TestKiln) => kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });

const reviewAsk = async (events: Awaited<ReturnType<TestKiln['events']>>): Promise<Ask> => {
  for (;;) {
    const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 });
    if (raised.payload.ask.type === 'review') return raised.payload.ask;
  }
};

test('a custom Workflow in .kiln drives the Project: its own Item kind moves through its Stages and Gate', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: { fixer: [{ do: 'write', path: 'fix.txt', content: 'fixed\n' }, { do: 'commit', message: 'Fix the crash' }] },
  });
  commitKilnFile(kiln, 'workflow.json', BUGS);

  const project = await register(kiln);
  assert.deepEqual(
    project.workflow.kinds.map((k) => [k.id, k.stages.map((s) => s.id).join(' > ')]),
    [['bug', 'fix > closed']],
  );

  const bug = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'bug', title: 'Crash on save' });
  assert.equal(bug.kind, 'bug');
  assert.equal(bug.stage, 'fix');
  assert.equal(bug.runState, 'backlog');

  const events = await kiln.events();
  const started = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(bug.id)}/start`);
  assert.equal(started.session?.role, 'fixer');
  assert.equal(started.session?.model, 'fake-small');

  const ask = await reviewAsk(events);
  assert.equal(ask.itemId, bug.id);
  await kiln.api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
  await events.next('item.merged', { timeoutMs: 30_000 });

  const closed = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === bug.id)!;
  assert.equal(closed.stage, 'closed');
  assert.equal(closed.runState, 'shipped');
  assert.equal(kiln.repo.git('show', 'main:fix.txt'), 'fixed\n');
});

const projectUpdated = async (events: Awaited<ReturnType<TestKiln['events']>>): Promise<Project> =>
  (await events.next<ProjectUpdatedEvent>('project.updated', { timeoutMs: 15_000 })).payload.project;

test('an invalid Workflow file is rejected with errors that point at the problem, and the Project keeps its last valid Workflow', async (t) => {
  const kiln = await startTestKiln(t);
  commitKilnFile(kiln, 'workflow.json', BUGS);
  const project = await register(kiln);
  const events = await kiln.events();

  const broken = structuredClone(BUGS);
  broken.kinds[0]!.stages[0]!.exit = ['branch_has_commits', 'bogus' as never];
  broken.kinds[0]!.stages[0]!.rework = 'nowhere';
  broken.kinds[0]!.parentKind = 'epic';
  commitKilnFile(kiln, 'workflow.json', broken);

  const updated = await projectUpdated(events);
  assert.deepEqual(
    updated.errors.map((e) => [e.file, e.at]),
    [
      ['.kiln/workflow.json', 'kinds[0].parentKind'],
      ['.kiln/workflow.json', 'kinds[0].stages[0].exit[1]'],
      ['.kiln/workflow.json', 'kinds[0].stages[0].rework'],
    ],
  );
  assert.match(updated.errors[1]!.message, /"bogus" is not an Exit check/);
  assert.deepEqual(updated.workflow, BUGS);
  assert.equal(updated.workflowSource, 'file');
  assert.deepEqual(await kiln.api<Project>('GET', `/api/projects/${project.id}`), updated);

  // Not JSON at all: one error for the whole file.
  commitKilnFile(kiln, 'workflow.json', '{ "name": ');
  const garbled = await projectUpdated(events);
  assert.deepEqual(garbled.errors.map((e) => [e.file, e.at]), [['.kiln/workflow.json', '']]);
  assert.match(garbled.errors[0]!.message, /not valid JSON/i);
  assert.deepEqual(garbled.workflow, BUGS);
});

test('a Stage that runs a Session without naming its model or its Agent is a validation error', async (t) => {
  const kiln = await startTestKiln(t);
  const unnamed = structuredClone(BUGS);
  delete unnamed.kinds[0]!.stages[0]!.model;
  unnamed.kinds[0]!.stages.splice(1, 0, { id: 'verify', name: 'Verify', role: 'verifier', model: 'fake-small' });
  commitKilnFile(kiln, 'workflow.json', unnamed);

  const project = await register(kiln);

  assert.deepEqual(project.errors, [
    { file: '.kiln/workflow.json', at: 'kinds[0].stages[0].model', message: 'Bug > Fix runs a Session, so it must name its model' },
    { file: '.kiln/workflow.json', at: 'kinds[0].stages[1].agent', message: 'Bug > Verify runs a Session, so it must name its Agent' },
  ]);
  // It never had a valid Workflow file, so it runs on the default until the file is fixed.
  assert.equal(project.workflowSource, 'default');
  assert.deepEqual(project.workflow.kinds.map((k) => k.id), ['epic', 'story', 'ticket']);
});

test('a Stage without a worktree cannot have an Exit check or a Gate that needs one', async (t) => {
  const kiln = await startTestKiln(t);
  const shapeless = structuredClone(BUGS);
  delete shapeless.kinds[0]!.stages[0]!.worktree;
  shapeless.kinds[0]!.stages[0]!.exit = ['children_exist', 'branch_has_commits'];
  commitKilnFile(kiln, 'workflow.json', shapeless);

  const project = await register(kiln);

  assert.deepEqual(project.errors, [
    {
      file: '.kiln/workflow.json',
      at: 'kinds[0].stages[0].exit[1]',
      message: 'Bug > Fix has no worktree, so it cannot check "branch_has_commits": give it "worktree": true',
    },
    {
      file: '.kiln/workflow.json',
      at: 'kinds[0].stages[0].gate',
      message: 'Bug > Fix has no worktree, so it has no branch for its Gate to merge: give it "worktree": true',
    },
  ]);
});

test('a Stage without a worktree checks its Exit and moves the Item on: an open blocking Ask holds it until answered', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent();
  commitKilnFile(kiln, 'workflow.json', {
    name: 'triage',
    kinds: [
      {
        id: 'bug',
        name: 'Bug',
        stages: [
          { id: 'triage', name: 'Triage', role: 'triager', agent: 'fake', model: 'fake-small', exit: ['no_open_blocking_asks'] },
          { id: 'closed', name: 'Closed' },
        ],
      },
    ],
  } satisfies Workflow);
  const project = await register(kiln);
  assert.deepEqual(project.errors, []);
  const bug = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'bug', title: 'Crash on save' });
  agent.setScript([
    {
      do: 'widget_ask',
      wait: false,
      ask: { type: 'decision', question: 'Is it a duplicate?', why: 'It may be known.', recommendation: 'No', options: ['No', 'Yes'], blocking: true, itemId: bug.id },
    },
    { do: 'finish' },
    { do: 'wait_for_message' },
  ]);
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(bug.id)}/start`);
  const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 })).payload;

  const held = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 })).payload.exit;
  assert.equal(held.met, false);
  assert.deepEqual(held.checks.map((c) => [c.id, c.met]), [['no_open_blocking_asks', false]]);
  assert.match(held.checks[0]!.detail ?? '', /Is it a duplicate\?/);

  await kiln.api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'No' });
  await kiln.api('POST', `/api/items/${encodeURIComponent(bug.id)}/messages`, { text: 'It is answered: finish again' });
  const met = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 })).payload.exit;
  assert.equal(met.met, true);
  for (;;) {
    const { item } = (await events.next<ItemUpdatedEvent>('item.updated', { timeoutMs: 15_000 })).payload;
    if (item.id === bug.id && item.stage === 'closed') break;
  }
  const closed = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === bug.id)!;
  assert.equal(closed.runState, 'shipped');
});

test('artifact_exists is met once a file beside the Item record is committed, and not by the record alone', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent();
  commitKilnFile(kiln, 'workflow.json', {
    name: 'notes',
    kinds: [
      {
        id: 'bug',
        name: 'Bug',
        stages: [
          { id: 'write', name: 'Write up', role: 'writer', agent: 'fake', model: 'fake-small', worktree: true, exit: ['artifact_exists'] },
          { id: 'closed', name: 'Closed' },
        ],
      },
    ],
  } satisfies Workflow);
  const project = await register(kiln);
  const bug = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'bug', title: 'Crash on save' });
  assert.ok(bug.path);
  const notes = `${bug.path.slice(0, bug.path.lastIndexOf('/'))}/notes.md`;
  agent.setScript([
    { do: 'finish' },
    { do: 'write', path: notes, content: 'What broke\n' },
    { do: 'commit', message: 'Write up the crash' },
  ]);
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(bug.id)}/start`);

  const missing = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 })).payload.exit;
  assert.deepEqual(missing.checks.map((c) => [c.id, c.met]), [['artifact_exists', false], ['no_coauthor_trailers', true]]);
  const met = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 })).payload.exit;
  assert.deepEqual(met.checks.map((c) => [c.id, c.met, c.detail]), [['artifact_exists', true, notes], ['no_coauthor_trailers', true, undefined]]);
});

test('the Project settings are read from .kiln/settings.json, live, and a bad setting is named', async (t) => {
  const kiln = await startTestKiln(t);
  const settings = {
    testCommand: 'npm test',
    knownCommands: ['npm run lint'],
    localOnly: true,
    mergeMode: 'pr',
    tracker: 'markdown',
  };
  commitKilnFile(kiln, 'settings.json', settings);

  const project = await register(kiln);
  assert.deepEqual(project.settings, settings);
  assert.equal(project.tracker, 'markdown');
  assert.deepEqual(project.errors, []);

  const events = await kiln.events();
  commitKilnFile(kiln, 'settings.json', { ...settings, mergeMode: 'squash', tracker: 'jira' });
  const updated = await projectUpdated(events);
  assert.deepEqual(updated.errors.map((e) => [e.file, e.at]), [
    ['.kiln/settings.json', 'mergeMode'],
    ['.kiln/settings.json', 'tracker'],
  ]);
  assert.match(updated.errors[0]!.message, /"merge" or "pr"/);
  assert.deepEqual(updated.settings, { testCommand: 'npm test', knownCommands: ['npm run lint'], localOnly: true });
});

test('modules in .kiln/settings.json resolve from the Project own .kiln/modules folder; an unknown id is a Project error', async (t) => {
  const kiln = await startTestKiln(t);
  commitKilnFile(kiln, 'modules/cad-part/kiln-module.json', { id: 'cad-part', name: 'CAD part', description: 'A printed part' });
  commitKilnFile(kiln, 'settings.json', { modules: ['cad-part'] });

  const project = await register(kiln);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.settings, { modules: ['cad-part'] });
  assert.equal(project.workflowSource, 'default');

  const events = await kiln.events();
  commitKilnFile(kiln, 'settings.json', { modules: ['cad-part', 'pcb'] });
  const updated = await projectUpdated(events);
  assert.deepEqual(updated.errors, [
    { file: '.kiln/settings.json', at: 'modules[1]', message: '"pcb" is not a module. The modules are: cad-part' },
  ]);
  assert.deepEqual(updated.settings, { modules: ['cad-part'] });

  // A broken module file in the Project is named, and the setting points at it.
  commitKilnFile(kiln, 'modules/cad-part/kiln-module.json', { id: 'cad-part', name: 'CAD part' });
  const broken = await projectUpdated(events);
  assert.deepEqual(broken.errors.map((e) => [e.file, e.at]), [
    ['.kiln/settings.json', 'modules[0]'],
    ['.kiln/settings.json', 'modules[1]'],
    ['.kiln/modules/cad-part/kiln-module.json', 'description'],
  ]);
  assert.equal(broken.errors[0]!.message, 'The "cad-part" module did not load: see .kiln/modules/cad-part/kiln-module.json');
  assert.equal(broken.errors[1]!.message, '"pcb" is not a module. No modules are available');
  assert.deepEqual(broken.settings, { modules: [] });

  commitKilnFile(kiln, 'settings.json', { modules: 'cad-part' });
  const shapeless = await projectUpdated(events);
  assert.deepEqual(shapeless.errors.map((e) => [e.file, e.at, e.message]).slice(0, 1), [
    ['.kiln/settings.json', 'modules', 'modules must be a list of module ids'],
  ]);
});

test('a Project with no modules field behaves as before: the default Workflow, no errors, no modules setting', async (t) => {
  const kiln = await startTestKiln(t);
  commitKilnFile(kiln, 'settings.json', { testCommand: 'npm test' });

  const project = await register(kiln);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.settings, { testCommand: 'npm test' });
  assert.equal(project.workflowSource, 'default');
  assert.deepEqual(project.workflow.kinds.map((k) => k.id), ['epic', 'story', 'ticket']);
});
