// Modules: the `kiln-module.json` validator and the module sources a Project's modules resolve from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_FILE, type Module } from '@kiln/widget-sdk';
import { tempDir, type Cleanup } from '@kiln/testing';
import { DEFAULT_MODULE_REPO, loadModules, moduleSources, validateModule } from '@kiln/core/modules';

const CAD: Module = {
  id: 'cad-part',
  name: 'CAD part',
  description: 'A 3D-printable part designed in OpenSCAD',
  presets: ['Printed part'],
  needs: { widgets: ['claude-code'] },
  skills: ['cad-part', 'heatset-insert'],
  mcpServers: {
    slicer: { command: 'node', args: ['slicer.js'], env: { MODE: 'cli' } },
    docs: { type: 'http', url: 'http://127.0.0.1:9000/mcp' },
  },
  exitChecks: [{ id: 'watertight', name: 'Every STL is watertight', command: 'node check.js', stages: ['implement'], replaces: 'tests_pass' }],
  stages: [{ kind: 'ticket', after: 'review', stage: { id: 'print-it', name: 'Print it', gate: true } }],
  template: { folder: 'template', ignore: ['out/'] },
  detect: ['*.scad', '*.stl'],
};

const problems = (raw: unknown) => {
  const result = validateModule(raw);
  assert.ok(Array.isArray(result), 'expected the module to be rejected');
  return result.map((p) => [p.at, p.message]);
};

test('a module file with every field is accepted as written; so is one with only id, name and description', () => {
  assert.deepEqual(validateModule(structuredClone(CAD)), CAD);
  const bare = { id: 'writing', name: 'Writing', description: 'Docs and plans' };
  assert.deepEqual(validateModule(bare), bare);
});

test('a module file that is not an object, or lacks its id, name or description, is rejected', () => {
  assert.deepEqual(problems([]), [['', 'A module file must be a JSON object']]);
  assert.deepEqual(problems({ id: 'Bad Id', name: ' ', extra: 1 }), [
    ['id', 'A module needs an id of lower-case letters, digits and dashes'],
    ['name', 'A module needs a name'],
    ['description', 'A module needs a one-line description'],
    ['extra', 'A module has no "extra". Its fields are: id, name, description, presets, needs, skills, mcpServers, exitChecks, stages, template, detect'],
  ]);
});

test('lists of names, needs and detect globs are checked entry by entry', () => {
  assert.deepEqual(problems({ ...CAD, presets: 'Software', skills: ['ok', ''], detect: [3], needs: { widgets: 'github', network: [] } }), [
    ['presets', 'presets must be a list of preset names'],
    ['needs.widgets', 'needs.widgets must be a list of Widget ids'],
    ['needs.network', 'needs has no "network": a module needs only widgets'],
    ['skills[1]', 'A skill is named by lower-case letters, digits and dashes'],
    ['detect[0]', 'A detect entry is a file glob, e.g. "*.scad"'],
  ]);
});

test('MCP servers need a command, or an http/sse type with a url', () => {
  assert.deepEqual(
    problems({ ...CAD, mcpServers: { a: { args: ['x'] }, b: { type: 'http' }, c: { type: 'ws', url: 'x' }, d: { command: 'x', args: 'y', env: { K: 1 } }, e: 'x' } }),
    [
      ['mcpServers.a.command', 'An MCP server runs a command, or has "type": "http" or "sse" and a url'],
      ['mcpServers.b.url', 'An http MCP server needs a url'],
      ['mcpServers.c.type', 'An MCP server type is "stdio", "http" or "sse", not "ws"'],
      ['mcpServers.d.args', 'args must be a list of strings'],
      ['mcpServers.d.env', 'env must map names to strings'],
      ['mcpServers.e', 'An MCP server entry must be a JSON object'],
    ],
  );
  assert.deepEqual(problems({ ...CAD, mcpServers: [] }), [['mcpServers', 'mcpServers maps server names to Claude Code MCP server entries']]);
});

test('Exit checks need an id, a name, a command and Stages, and can replace only a built-in check', () => {
  assert.deepEqual(
    problems({
      ...CAD,
      exitChecks: [
        { id: 'drc', name: 'DRC passes', command: 'kicad-cli pcb drc', stages: ['implement'] },
        { id: 'drc', name: '', command: ' ', stages: [], replaces: 'tests_fail' },
        'x',
      ],
    }),
    [
      ['exitChecks[1].id', 'Another Exit check of this module is also "drc"'],
      ['exitChecks[1].name', 'An Exit check needs a name'],
      ['exitChecks[1].command', 'An Exit check runs a command line in the worktree'],
      ['exitChecks[1].stages', 'An Exit check lists the Stage ids it is checked on'],
      ['exitChecks[1].replaces', '"tests_fail" is not an Exit check it can replace. The checks are: branch_has_commits, tree_clean, tests_pass, findings_exist, grill_record_exists, spec_exists, children_exist, artifact_exists, no_open_blocking_asks, no_coauthor_trailers'],
      ['exitChecks[2]', 'An Exit check must be a JSON object'],
    ],
  );
});

test('an Exit check with no command only takes away the check it replaces, so it must name one', () => {
  const drop = { id: 'no-tests', name: 'No test check', stages: ['implementing'], replaces: 'tests_pass' };
  assert.ok(!Array.isArray(validateModule({ ...CAD, exitChecks: [drop] })));
  assert.deepEqual(problems({ ...CAD, exitChecks: [{ ...drop, replaces: undefined }] }), [
    ['exitChecks[0].command', 'An Exit check runs a command line in the worktree, or has no command and replaces a check it takes away'],
  ]);
});

test('added Stages name their kind and the Stage they follow, and carry a Stage with an id and a name', () => {
  assert.deepEqual(
    problems({ ...CAD, stages: [{ kind: 'ticket', stage: { id: 'print-it', name: 'Print it', colour: 'red' } }, { kind: 'ticket', after: 'review', stage: { id: 'Print' } }] }),
    [
      ['stages[0].after', 'An added Stage names the Stage id it goes after'],
      ['stages[0].stage.colour', 'A Stage has no "colour"'],
      ['stages[1].stage.id', 'A Stage needs an id of lower-case letters, digits and dashes'],
      ['stages[1].stage.name', 'A Stage needs a name'],
    ],
  );
});

test('a template is a folder inside the module, with ignore lines', () => {
  assert.deepEqual(problems({ ...CAD, template: { folder: '../elsewhere', ignore: 'out/' } }), [
    ['template.folder', 'template.folder is a folder inside the module, not "../elsewhere"'],
    ['template.ignore', 'template.ignore must be a list of .gitignore lines'],
  ]);
  assert.deepEqual(problems({ ...CAD, template: 'template' }), [['template', 'template must be a JSON object with a folder']]);
});

/** A folder of module folders, each with its `kiln-module.json`. */
function moduleFolder(t: Cleanup, modules: Record<string, unknown>): string {
  const dir = tempDir(t, 'kiln-modules');
  for (const [folder, content] of Object.entries(modules)) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, MODULE_FILE), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const mod = (id: string, name = id) => ({ id, name, description: `The ${id} module` });

test('modules resolve from every source, and the earlier source wins when two have the same id', (t) => {
  const project = moduleFolder(t, { 'cad-part': mod('cad-part', 'Our CAD part') });
  const repo = moduleFolder(t, { 'cad-part': mod('cad-part', 'Default CAD part'), writing: mod('writing') });

  const { modules, problems: found } = loadModules([
    { folder: project, label: '.kiln/modules' },
    { folder: repo, label: 'modules' },
  ]);

  assert.deepEqual(found, []);
  assert.deepEqual([...modules.keys()].sort(), ['cad-part', 'writing']);
  assert.equal(modules.get('cad-part')!.module.name, 'Our CAD part');
  assert.equal(modules.get('cad-part')!.source, '.kiln/modules');
  assert.equal(modules.get('cad-part')!.folder, join(project, 'cad-part'));
  assert.equal(modules.get('writing')!.source, 'modules');
});

test('a bad module file is a problem named by its path, and a missing source folder is no source at all', (t) => {
  const repo = moduleFolder(t, {
    broken: '{ "id": ',
    wrong: mod('other'),
    invalid: { id: 'invalid' },
  });
  writeFileSync(join(repo, 'notes.txt'), 'not a module');
  mkdirSync(join(repo, 'empty'));

  const { modules, problems: found } = loadModules([
    { folder: join(repo, 'missing'), label: 'gone' },
    { folder: repo, label: '.kiln/modules' },
  ]);

  assert.deepEqual([...modules.keys()], []);
  assert.deepEqual(
    found.map((p) => [p.source, p.file, p.at]),
    [
      ['.kiln/modules', '.kiln/modules/broken/kiln-module.json', ''],
      ['.kiln/modules', '.kiln/modules/invalid/kiln-module.json', 'name'],
      ['.kiln/modules', '.kiln/modules/invalid/kiln-module.json', 'description'],
      ['.kiln/modules', '.kiln/modules/wrong/kiln-module.json', 'id'],
    ],
  );
  assert.match(found[0]!.message, /Not valid JSON/);
  assert.equal(found[3]!.message, 'The module in folder "wrong" has the id "other": a module folder is named by its id');
});

test('a Project resolves its own .kiln/modules ahead of the module repos, and the default repo is modules/ in this repo', (t) => {
  assert.ok(existsSync(join(DEFAULT_MODULE_REPO, '.gitkeep')), `${DEFAULT_MODULE_REPO} is the in-tree module repo`);
  const project = tempDir(t, 'kiln-project');
  const own = join(project, '.kiln', 'modules', 'writing');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, MODULE_FILE), JSON.stringify(mod('writing', 'Our writing')));
  const repo = moduleFolder(t, { writing: mod('writing', 'Default writing'), 'cad-part': mod('cad-part') });

  assert.deepEqual(moduleSources(project).map((s) => s.folder), [join(project, '.kiln', 'modules'), DEFAULT_MODULE_REPO]);
  const { modules } = loadModules(moduleSources(project, [repo]));
  assert.equal(modules.get('writing')!.module.name, 'Our writing');
  assert.equal(modules.get('cad-part')!.source, repo);
});
