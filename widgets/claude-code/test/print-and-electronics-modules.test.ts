// The in-tree 3D print and Electronics modules reach a Claude Code Session: the Bambu Studio MCP
// server (its command from the tool path Setting, else its name on PATH) and the bom-shopping and
// kicad skills. Driven with the fake SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import type { FakeLogEntry } from './fake-sdk/scenario.ts';
import { installClaudeCode } from './install.ts';

async function startTicket(kiln: TestKiln, modules: string[]) {
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ modules, testCommand: 'node -e ""' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Pull in the modules');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.deepEqual(project.errors, []);
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  await events.next('exit.checked', { timeoutMs: 20_000 });
}

const optionsOf = (log: FakeLogEntry[]) => {
  const entry = log.find((e) => e.kind === 'options');
  assert.ok(entry && entry.kind === 'options', 'the SDK got its options');
  return entry.options as { mcpServers: Record<string, unknown>; plugins?: { path: string }[] };
};

const DONE = [{ text: 'Done.' }];

test('a 3D print Session gets the Bambu Studio MCP server, its command from the tool path Setting', async (t) => {
  const kiln = await startTestKiln(t);
  const path = join(tempDir(t, 'kiln-tools'), 'bambu-studio-mcp');
  await kiln.api('PUT', '/api/setup', { toolPaths: { 'bambu-studio-mcp': path } });
  const claude = await installClaudeCode(t, kiln, { turns: [DONE] });
  await startTicket(kiln, ['3d-print']);
  const options = optionsOf(claude.log());
  assert.deepEqual(Object.keys(options.mcpServers).sort(), ['bambu-studio', 'kiln']);
  assert.deepEqual(options.mcpServers['bambu-studio'], { command: path });
  assert.equal(options.plugins, undefined, 'the 3D print module has no skills');
});

test('an Electronics Session gets the bom-shopping and kicad skills; with no Setting, the Bambu Studio server is found on PATH', async (t) => {
  const kiln = await startTestKiln(t);
  const claude = await installClaudeCode(t, kiln, { turns: [DONE] });
  await startTicket(kiln, ['electronics', '3d-print']);
  const options = optionsOf(claude.log());
  assert.deepEqual(options.mcpServers['bambu-studio'], { command: 'bambu-studio-mcp' });
  assert.equal(options.plugins?.length, 1);
  assert.deepEqual(readdirSync(join(options.plugins![0]!.path, 'skills')).sort(), ['bom-shopping', 'kicad']);
});
