import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP = new Set(['node_modules', 'dist', '.git']);
// The names Kiln used to have. Built from parts so this file doesn't match itself.
const OLD_NAMES = new RegExp(['gpu' + '-?board', 'x-' + 'gpuboard', 'model ' + 'monitor', 'gpu ' + 'board'].join('|'), 'i');

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mjs|js|json|html|css)$/.test(entry.name)) yield path;
  }
}

test('only the name Kiln appears in the code (no old board names)', () => {
  const offenders: string[] = [];
  for (const top of ['packages', 'widgets']) {
    for (const file of sourceFiles(join(ROOT, top))) {
      if (file !== SELF && OLD_NAMES.test(readFileSync(file, 'utf8'))) offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});
