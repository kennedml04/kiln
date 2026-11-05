// The Software, Writing and CAD part modules in the in-tree module repo (`modules/`): they validate,
// their templates hold the expected folders, CAD part's watertight check reads STLs, and a Writing
// Project's Ticket ships with no test command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Ask, AskRaisedEvent, ExitCheckedEvent, Item, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { DEFAULT_MODULE_REPO, loadModules, type LoadedModule } from '@kiln/core/modules';

const inTree = () => {
  const { modules, problems } = loadModules([{ folder: DEFAULT_MODULE_REPO, label: 'modules' }]);
  return { modules, problems };
};

const loaded = (id: string): LoadedModule => {
  const found = inTree().modules.get(id);
  assert.ok(found, `no in-tree module "${id}"`);
  return found;
};

/** Every file under `folder`, relative with `/`, sorted. */
const filesUnder = (folder: string): string[] =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((f) => statSync(join(folder, f)).isFile())
    .map((f) => f.split(sep).join('/'))
    .sort();

test('the Software, Writing and CAD part modules validate, each with its preset', () => {
  const { problems } = inTree();
  assert.deepEqual(problems, []);
  const software = loaded('software').module;
  assert.deepEqual(software.presets, ['Software']);
  assert.deepEqual(software.detect, ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
  assert.equal(software.exitChecks, undefined, 'Software is the shipped Workflow, tests_pass and all');

  const writing = loaded('writing').module;
  assert.deepEqual(writing.presets, ['Writing']);
  assert.equal(writing.detect, undefined, 'Writing is ticked by its preset only');

  const cad = loaded('cad-part').module;
  assert.deepEqual(cad.presets, ['Printed part']);
  assert.deepEqual(cad.skills, ['cad-part', 'heatset-insert', 'visualize']);
  assert.deepEqual(cad.detect, ['*.scad', '*.stl', '*.3mf', '*.step']);
});

test('the CAD part template makes cad/ and ignores out/; Software and Writing have no starter folders', () => {
  const cad = loaded('cad-part');
  assert.deepEqual(cad.module.template?.ignore, ['out/']);
  const template = join(cad.folder, cad.module.template!.folder);
  const files = filesUnder(template);
  assert.ok(files.length > 0 && files.every((f) => f.startsWith('cad/')), `the template holds only cad/: ${files.join(', ')}`);
  assert.equal(loaded('software').module.template, undefined);
  assert.equal(loaded('writing').module.template, undefined);
});

test('the CAD part skills are generic SKILL.md folders, named as the module lists them', () => {
  const cad = loaded('cad-part');
  for (const name of cad.module.skills!) {
    const text = readFileSync(join(cad.folder, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`), `${name} has its front matter`);
  }
  // Only skill folders and the check script ship: no settings, hooks or other tools' files.
  const shipped = filesUnder(cad.folder).filter((f) => !f.startsWith('template/') && !f.startsWith('skills/'));
  assert.deepEqual(shipped, ['checks/watertight.mjs', 'kiln-module.json']);
});

// ---- The watertight check ----

type Tri = [number, number, number][];
/** A closed tetrahedron: four faces, each edge shared by two. */
const CLOSED: Tri[] = [
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [1, 0, 0]],
  [[0, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
];
/** The same tetrahedron with one face missing. */
const OPEN = CLOSED.slice(0, 3);

const asciiStl = (tris: Tri[]) =>
  `solid test\n${tris
    .map((t) => `  facet normal 0 0 0\n    outer loop\n${t.map((v) => `      vertex ${v.join(' ')}\n`).join('')}    endloop\n  endfacet\n`)
    .join('')}endsolid test\n`;

const binaryStl = (tris: Tri[]) => {
  const buffer = Buffer.alloc(84 + 50 * tris.length);
  // A binary header that starts like an ASCII file, as some exporters write it.
  buffer.write('solid exported by a binary writer', 0, 'ascii');
  buffer.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const at = 84 + 50 * i;
    t.flat().forEach((n, j) => buffer.writeFloatLE(n, at + 12 + 4 * j));
  });
  return buffer;
};

const WATERTIGHT = join(DEFAULT_MODULE_REPO, 'cad-part', 'checks', 'watertight.mjs');
const runCheck = (cwd: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, [WATERTIGHT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, KILN_BASE: '' } });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
};

test('the watertight check passes a closed mesh and fails an open one, in ASCII and binary STL', (t) => {
  const dir = tempDir(t, 'kiln-watertight');
  writeFileSync(join(dir, 'closed.stl'), asciiStl(CLOSED));
  writeFileSync(join(dir, 'open.stl'), asciiStl(OPEN));
  writeFileSync(join(dir, 'closed-bin.stl'), binaryStl(CLOSED));
  writeFileSync(join(dir, 'open-bin.stl'), binaryStl(OPEN));

  for (const file of ['closed.stl', 'closed-bin.stl']) {
    const run = runCheck(dir, file);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, new RegExp(`${file.replace('.', '\\.')}: watertight \\(4 triangles\\)`));
  }
  for (const file of ['open.stl', 'open-bin.stl']) {
    const run = runCheck(dir, file);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /not watertight: 3 edges? not shared by exactly two triangles/);
  }
  const both = runCheck(dir, 'closed.stl', 'open.stl');
  assert.equal(both.code, 1);
  assert.match(both.output, /closed\.stl: watertight/);
  assert.match(both.output, /open\.stl: not watertight/);

  writeFileSync(join(dir, 'broken.stl'), 'solid nothing\nendsolid nothing\n');
  assert.match(runCheck(dir, 'broken.stl').output, /broken\.stl: no triangles/);
});

// ---- Through a Project ----

const TICKET = 'Draw the columns';
const FINDINGS = '.scratch/home-board/reviews/01-draw-the-columns.md';

async function register(kiln: TestKiln, settings: Record<string, unknown>) {
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify(settings));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Settings');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(project.errors, []);
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === TICKET)!;
  return { project, ticket };
}

const implementing = (project: Project) => project.workflow.kinds.find((k) => k.id === 'ticket')!.stages.find((s) => s.id === 'implementing')!;
const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

test('a CAD part Ticket must commit only watertight STLs: an open mesh in the diff fails the Exit, the closed one meets it', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: 'cad/bracket.stl', content: asciiStl(OPEN) },
        { do: 'commit', message: 'Bracket' },
        { do: 'finish', message: 'Done.' },
        { do: 'write', path: 'cad/bracket.stl', content: asciiStl(CLOSED) },
        { do: 'commit', message: 'Close the bracket' },
      ],
      reviewer: [],
    },
  });
  const { project, ticket } = await register(kiln, { modules: ['software', 'cad-part'], testCommand: 'node --version' });
  assert.deepEqual(implementing(project).exit, ['branch_has_commits', 'tree_clean', 'tests_pass', 'module:cad-part/watertight']);
  const events = await kiln.events();

  await start(kiln, ticket);
  const check = (e: ExitCheckedEvent) => e.payload.exit.checks.find((c) => c.id === 'module:cad-part/watertight')!;
  const first = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(check(first).name, 'Every STL in the diff is watertight');
  assert.equal(check(first).met, false);
  assert.match(check(first).detail!, /cad\/bracket\.stl: not watertight/);

  const second = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(check(second).met, true, check(second).detail);
  assert.match(check(second).detail!, /cad\/bracket\.stl: watertight \(4 triangles\)/);
});

test('a Writing Project has no test check: its Ticket ships through the review Gate with no test command', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: 'docs/plan.md', content: '# Plan\n' },
        { do: 'commit', message: 'Write the plan' },
      ],
      reviewer: [
        { do: 'write', path: FINDINGS, content: '# Review\n\nReads well.\n' },
        { do: 'commit', message: 'Review findings' },
      ],
    },
  });
  const { project, ticket } = await register(kiln, { modules: ['writing'] });
  assert.deepEqual(implementing(project).exit, ['branch_has_commits', 'tree_clean']);
  const review = project.workflow.kinds.find((k) => k.id === 'ticket')!.stages.find((s) => s.id === 'review')!;
  assert.equal(review.gate, true);
  const events = await kiln.events();

  await start(kiln, ticket);
  const checked = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 15_000 });
  assert.equal(checked.payload.exit.met, true, JSON.stringify(checked.payload.exit));
  let ask: Ask;
  do ask = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 30_000 })).payload.ask;
  while (ask.type !== 'review');
  const answered = await kiln.request('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: 'Approve' });
  assert.equal(answered.status, 200);
  await events.next('item.merged', { timeoutMs: 30_000 });
  const shipped = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === ticket.id)!;
  assert.equal(shipped.stage, 'shipped');
  assert.equal(kiln.repo.git('show', 'main:docs/plan.md'), '# Plan\n');
});
