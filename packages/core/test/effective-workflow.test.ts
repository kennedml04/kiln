// The effective Workflow: a Project's Workflow with its modules' Stages inserted and Exit checks applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Module, Workflow } from '@kiln/widget-sdk';
import { effectiveWorkflow } from '@kiln/core/effective-workflow';

/** A Ticket-only Workflow. Review runs a Session without naming its Agent, as the shipped default does. */
const BASE: Workflow = {
  name: 'default',
  kinds: [
    {
      id: 'ticket',
      name: 'Ticket',
      stages: [
        {
          id: 'implementing',
          name: 'Implementing',
          role: 'implementer',
          agent: 'fake',
          model: 'fake-small',
          worktree: true,
          exit: ['branch_has_commits', 'tree_clean', 'tests_pass'],
        },
        { id: 'review', name: 'Review', role: 'reviewer', worktree: true, exit: ['findings_exist'], gate: true },
        { id: 'shipped', name: 'Shipped' },
      ],
    },
  ],
};

const loaded = (module: Module) => ({ module, folder: `/modules/${module.id}`, source: '.kiln/modules' });
const mod = (id: string, fields: Partial<Module>): Module => ({ id, name: id, description: `The ${id} module`, ...fields });
const stagesOf = (workflow: Workflow | unknown[], kind = 'ticket') => {
  assert.ok(!Array.isArray(workflow), `expected a valid Workflow, got ${JSON.stringify(workflow)}`);
  return workflow.kinds.find((k) => k.id === kind)!.stages;
};

test('a Project with no modules gets exactly its Workflow', () => {
  const before = structuredClone(BASE);
  assert.equal(effectiveWorkflow(BASE, []), BASE);
  assert.deepEqual(BASE, before);
});

test("module Stages go in after the Stage they name, in module order, and a Stage with no role is the person's move", () => {
  const print = mod('print', { stages: [{ kind: 'ticket', after: 'review', stage: { id: 'print-it', name: 'Print it' } }] });
  const paint = mod('paint', { stages: [{ kind: 'ticket', after: 'review', stage: { id: 'paint-it', name: 'Paint it' } }] });
  const before = structuredClone(BASE);
  const stages = stagesOf(effectiveWorkflow(BASE, [loaded(print), loaded(paint)]));
  assert.deepEqual(stages.map((s) => s.id), ['implementing', 'review', 'print-it', 'paint-it', 'shipped']);
  assert.deepEqual(stages[2], { id: 'print-it', name: 'Print it' });
  assert.deepEqual(BASE, before, 'the Workflow passed in is left as it was');
});

test('a module Exit check sits beside the Stage\'s checks, or replaces the one it names', () => {
  const docs = mod('docs', { exitChecks: [{ id: 'links', name: 'Links resolve', command: 'node links.mjs', stages: ['implementing', 'review'] }] });
  const cad = mod('cad-part', {
    exitChecks: [{ id: 'watertight', name: 'Every STL is watertight', command: 'node check.mjs', stages: ['implementing'], replaces: 'tests_pass' }],
  });
  const stages = stagesOf(effectiveWorkflow(BASE, [loaded(docs), loaded(cad)]));
  assert.deepEqual(stages[0]!.exit, ['branch_has_commits', 'tree_clean', 'module:cad-part/watertight', 'module:docs/links']);
  assert.deepEqual(stages[1]!.exit, ['findings_exist', 'module:docs/links']);
  assert.equal(stages[2]!.exit, undefined);
});

test("a module's Exit check can go on a Stage the same module adds", () => {
  const print = mod('print', {
    stages: [{ kind: 'ticket', after: 'review', stage: { id: 'slice', name: 'Slice', worktree: true } }],
    exitChecks: [{ id: 'sliced', name: 'It slices', command: 'node slice.mjs', stages: ['slice'] }],
  });
  assert.deepEqual(stagesOf(effectiveWorkflow(BASE, [loaded(print)]))[2], { id: 'slice', name: 'Slice', worktree: true, exit: ['module:print/sliced'] });
});

test('a module that names an unknown kind or Stage, or makes the Workflow invalid, is a Project error on its file', () => {
  const broken = mod('broken', {
    stages: [
      { kind: 'bug', after: 'review', stage: { id: 'x', name: 'X' } },
      { kind: 'ticket', after: 'testing', stage: { id: 'y', name: 'Y' } },
      { kind: 'ticket', after: 'review', stage: { id: 'print-it', name: 'Print it', role: 'printer' } },
      { kind: 'ticket', after: 'implementing', stage: { id: 'review', name: 'Review again' } },
    ],
    exitChecks: [
      { id: 'sliced', name: 'It slices', command: 'node slice.mjs', stages: ['print-it'] },
      { id: 'lint', name: 'Lint', command: 'npm run lint', stages: ['nowhere'] },
    ],
  });
  const file = '.kiln/modules/broken/kiln-module.json';
  assert.deepEqual(effectiveWorkflow(BASE, [loaded(broken)]), [
    { file, at: 'stages[0].kind', message: '"bug" is not an Item kind of the Workflow. Its kinds are: ticket' },
    { file, at: 'stages[1].after', message: '"testing" is not a Stage of Ticket. Its Stages are: implementing, review, shipped' },
    { file, at: 'stages[3].stage.id', message: 'Ticket already has a Stage "review"' },
    { file, at: 'exitChecks[1].stages[0]', message: '"nowhere" is not a Stage of the Workflow' },
    { file, at: 'stages[2].stage.agent', message: 'Ticket > Print it runs a Session, so it must name its Agent' },
    { file, at: 'stages[2].stage.model', message: 'Ticket > Print it runs a Session, so it must name its model' },
    {
      file,
      at: 'exitChecks[0].stages',
      message: 'Ticket > Print it has no worktree, so it cannot check "module:broken/sliced": give it "worktree": true',
    },
  ]);
});
