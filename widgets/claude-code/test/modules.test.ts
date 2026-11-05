// A Project's modules reach its Claude Code Sessions: their skills as a per-Session plugin in the
// Widget's data folder (never the repo or worktree), their MCP servers in the Session's options,
// and those servers' tool calls through the Session's Policy. Driven with the fake SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExitCheckedEvent, Item, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import type { FakeLogEntry, FakeStep } from './fake-sdk/scenario.ts';
import { installClaudeCode } from './install.ts';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const skill = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo ${name} things.\n`;

/**
 * A Project whose tests pass when `answer.txt` says 42, with two modules of its own: `cad`, which it
 * uses, and `pcb`, which it doesn't. `cad` also holds files that are not skill folders.
 */
function moduleProject(kiln: TestKiln, settings: Record<string, unknown>, policy?: unknown) {
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', json({ testCommand: 'node check-answer.mjs', knownCommands: ['git add *', 'git commit *'], ...settings }));
  writeRepoFile(kiln.repo, 'check-answer.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('answer.txt', 'utf8').trim() !== '42') process.exit(1);\n");
  if (policy) writeRepoFile(kiln.repo, '.kiln/policy.json', json(policy));
  writeRepoFile(
    kiln.repo,
    '.kiln/modules/cad/kiln-module.json',
    json({ id: 'cad', name: 'CAD part', description: 'A printed part', skills: ['cad-part'], mcpServers: { printer: { command: 'node', args: ['printer.mjs'] } } }),
  );
  writeRepoFile(kiln.repo, '.kiln/modules/cad/skills/cad-part/SKILL.md', skill('cad-part'));
  writeRepoFile(kiln.repo, '.kiln/modules/cad/skills/cad-part/reference.md', 'Wall thickness: 2 mm.\n');
  writeRepoFile(kiln.repo, '.kiln/modules/cad/skills/unlisted/SKILL.md', skill('unlisted'));
  writeRepoFile(kiln.repo, '.kiln/modules/cad/settings.json', json({ hooks: { PreToolUse: [] } }));
  writeRepoFile(kiln.repo, '.kiln/modules/cad/hooks/hooks.json', json({ hooks: {} }));
  writeRepoFile(
    kiln.repo,
    '.kiln/modules/pcb/kiln-module.json',
    json({ id: 'pcb', name: 'Electronics', description: 'A board', skills: ['bom'], mcpServers: { kicad: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }),
  );
  writeRepoFile(kiln.repo, '.kiln/modules/pcb/skills/bom/SKILL.md', skill('bom'));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'A Project with modules');
}

const ANSWER: FakeStep[] = [
  { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
  { tool: 'Bash', input: { command: 'git add -A && git commit -q -m "Answer"' } },
  { text: 'Done.' },
];

async function runTicket(kiln: TestKiln) {
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(project.errors, []);
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session?.worktree);
  const exit = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 });
  return { session, exit: exit.payload.exit, events };
}

const optionsOf = (log: FakeLogEntry[]) => {
  const entry = log.find((e) => e.kind === 'options');
  assert.ok(entry && entry.kind === 'options', 'the SDK got its options');
  return entry.options as { mcpServers: Record<string, unknown>; plugins?: { type: string; path: string; skipMcpDiscovery?: boolean }[]; settingSources: unknown };
};

/** Every file under `dir`, relative to it, with forward slashes. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort();

const isInside = (folder: string, path: string) => !relative(folder, path).startsWith('..');

test("a Session gets its Project's module skills and MCP servers, from that module only, outside the repo and worktree", async (t) => {
  const kiln = await startTestKiln(t);
  moduleProject(kiln, { modules: ['cad'] });
  const claude = await installClaudeCode(t, kiln, { turns: [ANSWER] });
  const repoFiles = kiln.repo.git('ls-files').trim().split('\n').sort();
  const { session, exit } = await runTicket(kiln);
  assert.equal(exit.met, true);

  const options = optionsOf(claude.log());
  assert.deepEqual(options.settingSources, [], 'still no settings files');
  assert.deepEqual(Object.keys(options.mcpServers).sort(), ['kiln', 'printer']);
  assert.deepEqual(options.mcpServers.printer, { command: 'node', args: ['printer.mjs'] });
  assert.equal(options.plugins?.length, 1);
  const plugin = options.plugins![0]!;
  assert.equal(plugin.type, 'local');
  assert.equal(plugin.skipMcpDiscovery, true);
  // Only the listed skill folder, copied whole; none of the module's other files.
  assert.deepEqual(filesUnder(plugin.path), ['.claude-plugin/plugin.json', 'skills/cad-part/SKILL.md', 'skills/cad-part/reference.md']);
  assert.equal(readFileSync(join(plugin.path, 'skills', 'cad-part', 'SKILL.md'), 'utf8'), skill('cad-part'));
  assert.equal(JSON.parse(readFileSync(join(plugin.path, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'kiln-skills');

  // Nothing was written into the repo or the worktree.
  assert.ok(!isInside(kiln.repo.path, plugin.path) && !isInside(session.worktree!, plugin.path), plugin.path);
  assert.equal(kiln.repo.git('status', '--porcelain').trim(), '');
  // Registering writes the Project Policy template; nothing else is added.
  assert.deepEqual(kiln.repo.git('ls-files').trim().split('\n').sort(), [...repoFiles, '.kiln/policy.json'].sort());
  assert.equal(kiln.repo.git('-C', session.worktree!, 'ls-files', '--others').trim(), '', 'no untracked or ignored file in the worktree');
  assert.deepEqual(
    kiln.repo.git('diff', '--name-only', `main..${session.branch}`).trim().split('\n'),
    ['answer.txt'],
    'the Session branch holds only its own work',
  );
  assert.ok(!existsSync(join(session.worktree!, '.claude')));
});

test('a Session in a Project without the module gets neither its skills nor its MCP servers', async (t) => {
  const kiln = await startTestKiln(t);
  moduleProject(kiln, {});
  const claude = await installClaudeCode(t, kiln, { turns: [ANSWER] });
  await runTicket(kiln);

  const options = optionsOf(claude.log());
  assert.deepEqual(Object.keys(options.mcpServers), ['kiln']);
  assert.equal(options.plugins, undefined);
});

test("a module MCP server's tool calls go through the Session's Policy: a rule allows one, the action's rule denies the rest", async (t) => {
  const kiln = await startTestKiln(t);
  moduleProject(kiln, { modules: ['cad'] }, {
    actions: { other_commands: 'deny' },
    rules: [{ action: 'other_commands', match: 'mcp__printer__slice *', decision: 'allow' }],
  });
  const claude = await installClaudeCode(t, kiln, {
    turns: [
      [
        { tool: 'mcp__printer__slice', input: { file: 'part.stl' } },
        { tool: 'mcp__printer__print', input: { file: 'part.gcode' } },
        { tool: 'Skill', input: { skill: 'kiln-skills:cad-part' } },
        ...ANSWER,
      ],
    ],
  });
  const { exit } = await runTicket(kiln);
  assert.equal(exit.met, true);

  const tools = claude.log().flatMap((e) => (e.kind === 'tool' ? [[e.name, e.outcome, e.via]] : []));
  assert.deepEqual(tools.slice(0, 3), [
    ['mcp__printer__slice', 'ran', 'hook'],
    ['mcp__printer__print', 'denied', 'hook'],
    ['Skill', 'ran', 'hook'],
  ]);
  const denied = claude.log().find((e) => e.kind === 'tool' && e.name === 'mcp__printer__print');
  assert.match(denied && denied.kind === 'tool' ? (denied.message ?? '') : '', /Policy says deny for other_commands: mcp__printer__print/);
});
