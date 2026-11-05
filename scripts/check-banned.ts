// Mechanical rules the code review used to catch by hand. Run by `npm test`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

type Rule = { name: string; fix: string; appliesTo: (file: string) => boolean; find: (text: string) => number[] };

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const linesOf = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => lineOf(text, m.index));

const TEXT_FILE = /\.(ts|tsx|mjs|cjs|js|jsx|json|md|css|html|yml|yaml|toml|sh|ps1|txt)$|(^|\/)(LICENSE|\.gitignore)$/;
// A home folder named outright (C:\Users\<name>, /Users/<name>, /home/<name>). `<you>` placeholders pass.
const PERSONAL_PATH = /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!<)[A-Za-z]|\/Users\/(?!<)[A-Za-z]|\/home\/(?!<)[a-z]/g;
// Words private to this PC (names, other repos, addresses), listed outside the repo so the repo never
// names them: KILN_PRIVATE_WORDS, separated by ";". Matched as whole words, any case.
const privateWords = (process.env.KILN_PRIVATE_WORDS ?? '').split(';').map((w) => w.trim()).filter(Boolean);
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PRIVATE = privateWords.length ? new RegExp(`(?<![\\w-])(?:${privateWords.map(escape).join('|')})(?![\\w-])`, 'gi') : undefined;

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
  {
    name: 'control byte',
    fix: 'A shell write (heredoc, echo, printf) turned an escape into a raw byte. Rewrite the line with the Edit tool.',
    appliesTo: (file) => TEXT_FILE.test(file),
    find: (text) => linesOf(text, /[\x00-\x08\x0B\x0C\x0E-\x1F]/g),
  },
  {
    name: "a person's home folder",
    fix: 'The repo is public: write the path generically (C:\\Users\\<you>\\..., homedir(), an env var).',
    appliesTo: (file) => TEXT_FILE.test(file),
    find: (text) => linesOf(text, PERSONAL_PATH),
  },
  {
    name: 'a word private to this PC (KILN_PRIVATE_WORDS)',
    fix: 'The repo is public: drop or generalise it (another repo, a name, an address).',
    appliesTo: (file) => PRIVATE !== undefined && TEXT_FILE.test(file),
    find: (text) => (PRIVATE ? linesOf(text, PRIVATE) : []),
  },
];

// Everything that is published: the code, the modules, the tracker, the docs and the files at the root.
const roots = ['packages', 'widgets', 'modules', 'scripts', '.scratch', 'docs'];
const skip = new Set(['node_modules', 'dist', '.git']);

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

const rootFiles = readdirSync('.', { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

let failures = 0;
for (const root of [...roots, ...rootFiles]) {
  for (const file of rootFiles.includes(root) ? [root] : files(root)) {
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
