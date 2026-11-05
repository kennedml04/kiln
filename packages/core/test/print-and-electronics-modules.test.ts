// The 3D print and Electronics modules (in-tree under `modules/`): they validate, their template and
// Stages reach a Project, and their Exit checks (a Bambu Studio slice, a KiCad DRC) pass and fail as
// the tools' output says. Both CLIs are fakes made here; the real tools run only with
// KILN_REAL_CAD_TOOLS=1 (see the end of this file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExitCheckedEvent, Item, Project, ProjectScan, SetupState, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { DEFAULT_MODULE_REPO, loadModules } from '@kiln/core/modules';
import { fakeBambuStudio, fakeKicadCli, type FakeDrcInput, type FakeSliceInput } from './fake-cad-tools.ts';

const OURS = ['3d-print', 'electronics'];
const SLICE = join(DEFAULT_MODULE_REPO, '3d-print', 'checks', 'slice.mjs');
const DRC = join(DEFAULT_MODULE_REPO, 'electronics', 'checks', 'drc.mjs');

const inTree = () => loadModules([{ folder: DEFAULT_MODULE_REPO, label: 'modules' }]);

/** Runs a module's check script as the exit checker would: in `cwd`, with the tool argument given. */
function runCheck(script: string, cwd: string, tool: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, tool], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test('both modules validate; Electronics brings its bom-shopping skill and a pcb/ template with an ignored out/', () => {
  const { modules, problems } = inTree();
  assert.deepEqual(problems.filter((p) => OURS.includes(p.folderName)), []);
  const print = modules.get('3d-print')!.module;
  const electronics = modules.get('electronics')!;
  assert.deepEqual(print.detect, ['*.3mf', '*.gcode']);
  assert.deepEqual(electronics.module.detect, ['*.kicad_pro']);
  assert.ok(print.mcpServers?.['bambu-studio'], 'the Bambu Studio MCP server entry');
  assert.deepEqual(electronics.module.skills, ['bom-shopping', 'kicad']);
  for (const skill of electronics.module.skills!) assert.ok(existsSync(join(electronics.folder, 'skills', skill, 'SKILL.md')), skill);
  assert.deepEqual(electronics.module.template?.ignore, ['out/']);
  assert.ok(existsSync(join(electronics.folder, electronics.module.template!.folder, 'pcb')), 'the pcb/ starter folder');
  // Kiln-only words stay out of skills a Session reads: no tool paths or private names.
  const skill = readFileSync(join(electronics.folder, 'skills', 'bom-shopping', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: bom-shopping\ndescription: /);
});

const project = async (kiln: TestKiln, modules: string[]) => {
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ modules, testCommand: 'node -e ""' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Pull in the modules');
  return kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
};

const stagesOf = (p: Project, kind: string) => p.workflow.kinds.find((k) => k.id === kind)!.stages;

test("their Stages and Exit checks appear in a Project's effective Workflow, and the scan suggests them from files", async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const both = await project(kiln, OURS);
  assert.deepEqual(both.errors, []);
  const ticket = stagesOf(both, 'ticket');
  assert.deepEqual(ticket.map((s) => s.id), ['implementing', 'review', 'print-it', 'order-parts', 'shipped']);
  // The checks sit beside tests_pass, so a Project with firmware keeps its tests.
  assert.deepEqual(ticket[0]!.exit, ['branch_has_commits', 'tree_clean', 'tests_pass', 'module:3d-print/slice', 'module:electronics/drc']);
  for (const id of ['print-it', 'order-parts']) {
    const stage = ticket.find((s) => s.id === id)!;
    assert.equal(stage.role, undefined, `${id} has no role: it is the person's move`);
    assert.equal(stage.worktree, undefined);
  }
  assert.deepEqual(
    ticket.filter((s) => s.id === 'print-it' || s.id === 'order-parts').map((s) => s.name),
    ['Print it', 'Order parts'],
  );

  const dir = tempDir(t, 'kiln-scan-cad');
  writeFileSync(join(dir, 'board.kicad_pro'), '{}');
  writeFileSync(join(dir, 'case.gcode'), '; gcode');
  const scan = await kiln.api<ProjectScan>('POST', '/api/projects/scan', { path: dir });
  const suggested = scan.modules.filter((m) => m.suggested).map((m) => [m.id, m.matches]);
  assert.deepEqual(suggested.filter(([id]) => OURS.includes(id as string)), [
    ['3d-print', ['case.gcode']],
    ['electronics', ['board.kicad_pro']],
  ]);
});

test('the tool paths are a Setting: absolute paths only, and setup lists the tools the modules use', async (t) => {
  const kiln = await startTestKiln(t);
  const state = await kiln.api<SetupState>('GET', '/api/setup');
  for (const tool of ['bambu-studio', 'bambu-studio-mcp', 'kicad-cli']) assert.ok(state.tools.includes(tool), tool);
  assert.equal((await kiln.request('PUT', '/api/setup', { toolPaths: { 'kicad-cli': 'relative/kicad-cli' } })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/setup', { toolPaths: { 'Bad Name': '/x' } })).status, 400);
  const path = join(tempDir(t, 'kiln-tools'), 'kicad-cli');
  const saved = await kiln.api<SetupState>('PUT', '/api/setup', { toolPaths: { 'kicad-cli': path } });
  assert.deepEqual(saved.settings.toolPaths, { 'kicad-cli': path });
  // An empty path clears the tool: it is found on PATH again.
  const cleared = await kiln.api<SetupState>('PUT', '/api/setup', { toolPaths: { 'kicad-cli': '' } });
  assert.deepEqual(cleared.settings.toolPaths, {});
});

/**
 * A Ticket in a Project with `module` whose implementer commits `file` twice: first with `bad`, then,
 * after the Exit feedback, with `good`. Returns the two Exit results for the module's check.
 */
async function checkTwice(t: Parameters<typeof startTestKiln>[0], module: string, check: string, file: string, bad: unknown, good: unknown, toolPaths: Record<string, string>) {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: {
      implementer: [
        { do: 'write', path: file, content: JSON.stringify(bad) },
        { do: 'commit', message: 'First try' },
        { do: 'finish', message: 'Done.' },
        { do: 'write', path: file, content: JSON.stringify(good) },
        { do: 'commit', message: 'Fix it' },
      ],
      reviewer: [],
    },
  });
  seedScratch(kiln.repo);
  await kiln.api('PUT', '/api/setup', { toolPaths });
  const p = await project(kiln, [module]);
  assert.deepEqual(p.errors, []);
  const item = (await kiln.api<Item[]>('GET', `/api/projects/${p.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);
  const id = `module:${module}/${check}`;
  const first = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 30_000 })).payload.exit.checks.find((c) => c.id === id)!;
  const second = (await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 30_000 })).payload.exit.checks.find((c) => c.id === id)!;
  return { first, second };
}

test('"The slice reports no problems" fails while Bambu Studio lists a problem, and passes once it lists none', async (t) => {
  const slicer = fakeBambuStudio(t);
  const bad: FakeSliceInput = { warnings: ['Floating regions on plate 1', 'Filament runs out'] };
  const good: FakeSliceInput = { warnings: [] };
  const { first, second } = await checkTwice(t, '3d-print', 'slice', 'parts/case.3mf', bad, good, { 'bambu-studio': slicer.path });
  assert.equal(first.name, 'The slice reports no problems');
  assert.equal(first.met, false);
  assert.match(first.detail!, /parts\/case\.3mf: 2 problems\n {2}- plate 1: Floating regions on plate 1\n {2}- plate 1: Filament runs out/);
  assert.equal(second.met, true, second.detail);
  assert.match(second.detail!, /parts\/case\.3mf: sliced, no problems/);
  // The fake was the Setting's path, called with the Bambu Studio CLI's slice arguments.
  const call = slicer.calls()[0]!;
  assert.deepEqual([call[0], call[1], call[2]], ['--slice', '0', '--outputdir']);
  assert.match(call.at(-1)!, /case\.3mf$/);
});

test('"DRC passes" fails on DRC errors, and passes with only warnings', async (t) => {
  const kicad = fakeKicadCli(t);
  const bad: FakeDrcInput = { violations: [{ severity: 'error', type: 'clearance', description: 'Clearance violation (0.1 mm)' }], unconnected: 1 };
  const good: FakeDrcInput = { violations: [{ severity: 'warning', type: 'silk_overlap', description: 'Silkscreen overlap' }] };
  const { first, second } = await checkTwice(t, 'electronics', 'drc', 'pcb/board.kicad_pcb', bad, good, { 'kicad-cli': kicad.path });
  assert.equal(first.name, 'DRC passes');
  assert.equal(first.met, false);
  assert.match(first.detail!, /pcb\/board\.kicad_pcb: 2 DRC errors\n {2}- \[clearance\] Clearance violation \(0\.1 mm\)\n {2}- \[unconnected_items\] Missing connection between items: Pad 1/);
  assert.equal(second.met, true, second.detail);
  assert.match(second.detail!, /pcb\/board\.kicad_pcb: DRC passes \(1 warning\)/);
  const call = kicad.calls()[0]!;
  assert.deepEqual(call.slice(0, 2), ['pcb', 'drc']);
  assert.ok(call.includes('--format') && call.includes('json') && call.includes('--severity-all'), call.join(' '));
});

test('with no tool path Setting, the checks find the tool on PATH, and say how to set it when it is not there', (t) => {
  const kicad = fakeKicadCli(t);
  const slicer = fakeBambuStudio(t);
  const dir = tempDir(t, 'kiln-cad-work');
  writeFileSync(join(dir, 'board.kicad_pcb'), JSON.stringify({ violations: [] }));
  writeFileSync(join(dir, 'case.3mf'), JSON.stringify({ error: 'Nothing to be sliced' }));
  const path = { PATH: `${kicad.dir}${delimiter}${slicer.dir}${delimiter}${process.env.PATH ?? ''}` };

  const drc = runCheck(DRC, dir, 'kicad-cli', path);
  assert.equal(drc.code, 0, drc.output);
  assert.match(drc.output, /board\.kicad_pcb: DRC passes/);
  const slice = runCheck(SLICE, dir, 'bambu-studio', path);
  assert.equal(slice.code, 1, slice.output);
  assert.match(slice.output, /case\.3mf: 1 problem\n {2}- Nothing to be sliced/);

  const missing = runCheck(DRC, dir, 'kiln-test-no-kicad-cli');
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Can't find kicad-cli \(kiln-test-no-kicad-cli\)\. Set its path in Settings > Tool paths, or put it on PATH\./);
});

test('a worktree with no board or model file to check passes without running a tool', (t) => {
  const dir = tempDir(t, 'kiln-cad-empty');
  writeFileSync(join(dir, 'README.md'), '# Nothing yet\n');
  const drc = runCheck(DRC, dir, 'kiln-test-no-kicad-cli');
  assert.equal(drc.code, 0, drc.output);
  assert.match(drc.output, /No \.kicad_pcb board to check/);
  const slice = runCheck(SLICE, dir, 'kiln-test-no-bambu-studio');
  assert.equal(slice.code, 0, slice.output);
  assert.match(slice.output, /No \.3mf model to slice/);
});

// ---- The real tools: opt-in only ----

const REAL = process.env.KILN_REAL_CAD_TOOLS === '1';
const SKIP_REAL = REAL ? false : 'set KILN_REAL_CAD_TOOLS=1 to run the real Bambu Studio and KiCad CLIs';

/** A 10 mm cube as an ASCII STL. */
function cubeStl(): string {
  const v = (x: number, y: number, z: number) => `      vertex ${x * 10} ${y * 10} ${z * 10}`;
  const faces: [number, number, number][][] = [
    [[0, 0, 0], [0, 1, 0], [1, 1, 0]], [[0, 0, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1]], [[0, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1]], [[0, 1, 0], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1]], [[0, 0, 0], [0, 1, 1], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1], [1, 0, 1]],
  ];
  const body = faces.map((f) => `  facet normal 0 0 0\n    outer loop\n${f.map((p) => v(...p)).join('\n')}\n    endloop\n  endfacet`).join('\n');
  return `solid cube\n${body}\nendsolid cube\n`;
}

test('real: the slice check runs the real Bambu Studio CLI on a cube', { skip: SKIP_REAL }, (t) => {
  const dir = tempDir(t, 'kiln-real-slice');
  writeFileSync(join(dir, 'cube.stl'), cubeStl());
  const tool = process.env.KILN_TOOL_BAMBU_STUDIO ?? 'bambu-studio';
  const result = spawnSync(process.execPath, [SLICE, tool, 'cube.stl'], { cwd: dir, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /Can't find/, output);
  assert.match(output, /cube\.stl: /, output);
});

test('real: the DRC check runs the real kicad-cli on an empty board', { skip: SKIP_REAL }, (t) => {
  const dir = tempDir(t, 'kiln-real-drc');
  writeFileSync(join(dir, 'empty.kicad_pcb'), '(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0"))\n');
  const tool = process.env.KILN_TOOL_KICAD_CLI ?? 'kicad-cli';
  const result = runCheck(DRC, dir, tool);
  assert.doesNotMatch(result.output, /Can't find|wrote no report/, result.output);
  assert.match(result.output, /empty\.kicad_pcb: /, result.output);
});
