// The demo template (`packages/demo/template/`): the toy project the demo copies verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type FakeAgentScript, type FakeAgentStep } from '@kiln/testing';
import { waitForItems } from '@kiln/testing/tracker-contract';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const template = join(repoRoot, 'packages', 'demo', 'template');
const STORY = 'Add `slugify(title)`';

const copyTemplate = (t: Parameters<typeof tempDir>[0]) => {
  const dir = tempDir(t, 'kiln-demo-template');
  cpSync(template, dir, { recursive: true });
  return dir;
};

test('node --test passes in a fresh copy of the template', (t) => {
  const dir = copyTemplate(t);
  // Without NODE_TEST_CONTEXT the child reports as a plain run, not to this test runner.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8', env });
  assert.match(output, /# pass [1-9]/);
  assert.match(output, /# fail 0/);
});

type Write = Extract<FakeAgentStep, { do: 'write' }>;

test("the Replay implementers' writes for Tickets 01 and 02, applied to a fresh copy, pass node --test", (t) => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'packages', 'demo', 'replay', 'scripts.json'), 'utf8')) as Record<string, FakeAgentScript>;
  const writes = (key: string) => scripts[key]!.filter((step): step is Write => step.do === 'write');
  const first = writes('implementer@for the ticket "Slugify function"');
  const second = writes('implementer@for the ticket "Slugify CLI"');
  assert.deepEqual(first.map((w) => w.path).sort(), ['src/slugify.js', 'test/slugify.test.js']);
  assert.ok(second.some((w) => w.path === 'src/cli.js') && second.some((w) => w.path === 'test/cli.test.js'));
  // 02 may start before 01 merges (Blocked by is not enforced), so it carries 01's src/slugify.js
  // byte for byte: the two branches then merge cleanly in either order.
  const carried = second.find((w) => w.path === 'src/slugify.js');
  assert.equal(carried?.content, first.find((w) => w.path === 'src/slugify.js')!.content);

  const dir = copyTemplate(t);
  for (const write of [...first, ...second]) {
    mkdirSync(dirname(join(dir, write.path)), { recursive: true });
    writeFileSync(join(dir, write.path), write.content);
  }
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8', env });
  assert.match(output, /# pass [1-9]/);
  assert.match(output, /# fail 0/);
  assert.match(output, /the CLI prints the slug/);
  assert.match(output, /accents are stripped/);
});

test("the monorepo's install leaves the template's package.json out", () => {
  const name = JSON.parse(readFileSync(join(template, 'package.json'), 'utf8')).name as string;
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
  assert.deepEqual(Object.keys(lock.packages).filter((path) => path.startsWith('packages/demo')), []);
  assert.equal(lock.packages[`node_modules/${name}`], undefined);
});

test('a test core registers the template and its Tracker reads one Story at Grill', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = copyTemplate(t);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Kiln test', '-c', 'user.email=test@kiln.invalid', 'commit', '-q', '-m', 'Demo project');

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir });
  const items: Item[] = await waitForItems(kiln, project.id, [STORY]);

  assert.deepEqual(
    items.map((i) => ({ kind: i.kind, title: i.title, stage: i.stage })),
    [{ kind: 'story', title: STORY, stage: 'grill' }],
  );
  // The griller reads the whole Story file; the Item's description is only its first paragraph.
  const body = readFileSync(join(dir, items[0]!.path ?? ''), 'utf8').replace(/^---[\s\S]*?---/, '');
  assert.match(body, /accented letters\?/i);
  assert.match(body, /empty result an error\?/i);
});
