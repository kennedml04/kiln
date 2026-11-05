// The demo template (`packages/demo/template/`): the toy project the demo copies verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, tempDir } from '@kiln/testing';
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
