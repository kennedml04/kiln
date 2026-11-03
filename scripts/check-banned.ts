// Mechanical rules the code review used to catch by hand. Run by `npm test`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

type Rule = { name: string; fix: string; appliesTo: (file: string) => boolean; find: (text: string) => number[] };

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

const rules: Rule[] = [
  {
    name: 'rmSync removing a folder',
    fix: 'On Node 24 rmSync ignores maxRetries and throws EPERM on Windows. Use removeFolder() from packages/core/src/exec.ts (fs.promises.rm with retries).',
    appliesTo: (file) => /\.(ts|tsx|mjs|js)$/.test(file),
    find: (text) =>
      [...text.matchAll(/\brmSync\s*\(/g)]
        .filter((m) => /\b(recursive|maxRetries)\b/.test(text.slice(m.index, text.indexOf(')', m.index) + 1)))
        .map((m) => lineOf(text, m.index)),
  },
  {
    name: 'test importing an internal module',
    fix: 'Tests drive Kiln from outside: use @kiln/testing (startTestKiln, openShell) or the Widget\'s own entry point.',
    appliesTo: (file) => /[\\/]test[\\/].*\.(ts|tsx)$/.test(file),
    find: (text) =>
      [...text.matchAll(/(?:\bfrom|\bimport\s*\()\s*['"](\.[^'"]*\/src\/[^'"]*)['"]/g)].map((m) => lineOf(text, m.index)),
  },
];

const roots = ['packages', 'widgets'];
const skip = new Set(['node_modules', 'dist', '.git']);

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

let failures = 0;
for (const root of roots) {
  for (const file of files(root)) {
    const rel = relative('.', file).split(sep).join('/');
    const applicable = rules.filter((rule) => rule.appliesTo(rel));
    if (applicable.length === 0) continue;
    const text = readFileSync(file, 'utf8');
    for (const rule of applicable) {
      for (const line of rule.find(text)) {
        console.error(`${rel}:${line}  ${rule.name}. ${rule.fix}`);
        failures++;
      }
    }
  }
}
if (failures > 0) process.exit(1);
