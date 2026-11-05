// A Project's modules in its Workflow: their Stages show on the board, and their command Exit checks run
// in the Item's worktree with their output in the Thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExitCheckedEvent, Item, Module, Project, ProjectUpdatedEvent, StartResult, ThreadEntry } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const ANSWERS: Module = {
  id: 'answers',
  name: 'Answers',
  description: 'Checks the answer',
  exitChecks: [{ id: 'is-42', name: 'The answer is 42', command: 'node check-answer.mjs', stages: ['implementing'], replaces: 'tests_pass' }],
  stages: [{ kind: 'ticket', after: 'review', stage: { id: 'print-it', name: 'Print it' } }],
};

/** Commits the module under `.kiln/modules`, the settings that pull it in, and the script its check runs. */
function addModule(kiln: TestKiln, module: Module) {
  writeRepoFile(kiln.repo, `.kiln/modules/${module.id}/kiln-module.json`, `${JSON.stringify(module, null, 2)}\n`);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ modules: [module.id] }));
  writeRepoFile(
    kiln.repo,
    'check-answer.mjs',
    "import { readFileSync } from 'node:fs';\nconst answer = readFileSync('answer.txt', 'utf8').trim();\nif (answer !== '42') {\n  console.error(`expected 42, got ${answer}`);\n  process.exit(1);\n}\nconsole.log('the answer is right');\n",
  );
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', `Add the ${module.id} module`);
}

const ticketStages = (project: Project) => project.workflow.kinds.find((k) => k.id === 'ticket')!.stages;

test('a command Exit check runs in the worktree: a non-zero exit fails it with its output in the Thread, then it passes', async (t) => {
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
      reviewer: [],
    },
  });
  seedScratch(kiln.repo);
  addModule(kiln, ANSWERS);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(project.errors, []);
  assert.deepEqual(ticketStages(project).map((s) => s.id), ['implementing', 'review', 'print-it', 'shipped']);
  assert.deepEqual(ticketStages(project)[0]!.exit, ['branch_has_commits', 'tree_clean', 'module:answers/is-42']);
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();

  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  const first = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.deepEqual(first.payload.exit.checks.map((c) => [c.id, c.name, c.met]), [
    ['branch_has_commits', 'Branch has commits', true],
    ['tree_clean', 'Working tree clean', true],
    ['module:answers/is-42', 'The answer is 42', false],
    ['no_coauthor_trailers', 'No Co-Authored-By trailers', true],
  ]);
  assert.match(first.payload.exit.checks[2]!.detail!, /`node check-answer\.mjs` exited with 1\nexpected 42, got 41/);

  const second = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(second.payload.exit.met, true);
  assert.match(second.payload.exit.checks[2]!.detail!, /the answer is right/);

  const thread = await kiln.api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/thread`);
  const details = thread
    .filter((e) => e.type === 'exit.checked')
    .map((e) => (e.payload.exit as ExitCheckedEvent['payload']['exit']).checks.find((c) => c.id === 'module:answers/is-42')?.detail ?? '');
  assert.equal(details.length, 2);
  assert.match(details[0]!, /expected 42, got 41/);
  assert.match(details[1]!, /the answer is right/);
});

test('a module that makes the Workflow invalid is a Project error, and the Project keeps its last valid Workflow', async (t) => {
  const kiln = await startTestKiln(t);
  addModule(kiln, ANSWERS);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const valid = project.workflow;
  assert.ok(ticketStages(project).some((s) => s.id === 'print-it'));
  const events = await kiln.events();

  const broken: Module = { ...ANSWERS, stages: [{ kind: 'ticket', after: 'testing', stage: { id: 'print-it', name: 'Print it' } }] };
  writeRepoFile(kiln.repo, '.kiln/modules/answers/kiln-module.json', JSON.stringify(broken));
  kiln.repo.git('commit', '-q', '-am', 'Break the module');
  const updated = (await events.next<ProjectUpdatedEvent>('project.updated', { timeoutMs: 15_000 })).payload.project;
  assert.deepEqual(updated.errors, [
    {
      file: '.kiln/modules/answers/kiln-module.json',
      at: 'stages[0].after',
      message: '"testing" is not a Stage of Ticket. Its Stages are: implementing, review, shipped',
    },
  ]);
  assert.deepEqual(updated.workflow, valid);
});

test('a Project with no modules keeps exactly the shipped Workflow', async (t) => {
  const kiln = await startTestKiln(t);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ modules: [] }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'No modules');
  const withEmpty = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(withEmpty.errors, []);
  assert.deepEqual(ticketStages(withEmpty).map((s) => [s.id, s.exit]), [
    ['implementing', ['branch_has_commits', 'tree_clean', 'tests_pass']],
    ['review', ['findings_exist']],
    ['shipped', undefined],
  ]);
});
