// Finding and running a tool from a module check: plain Node, no dependencies. Kiln passes the
// tool as the Setting's path (Settings > Tool paths) or, when that is unset, as its bare name,
// which is looked up on PATH here.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The tool's full path: the one given, or the first match of a bare name on PATH. Unset when not found. */
export function findTool(given) {
  if (/[\\/]/.test(given)) return isFile(given) ? given : undefined;
  const windows = process.platform === 'win32';
  const extensions = windows ? [...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean), ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const path = join(dir, given + extension);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

/** The message for a tool that is not there. */
export const missingTool = (name, given) =>
  `Can't find ${name} (${given}). Set its path in Settings > Tool paths, or put it on PATH.`;

const TIMEOUT_MS = 9 * 60_000;

/** Runs the tool and waits: its exit code and output. A .cmd or .bat launcher runs through the shell. */
export function runTool(path, args) {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path);
  const options = { encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const result = viaShell
    ? spawnSync([path, ...args].map((a) => `"${a}"`).join(' '), { ...options, shell: true })
    : spawnSync(path, args, options);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim();
  return { code: result.status, output };
}

const SKIPPED = new Set(['.git', 'node_modules', 'out']);

/** The files under `root` with one of the extensions, repo-relative with forward slashes, sorted. */
export function findFiles(root, extensions) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(join(dir, entry.name));
      } else if (extensions.some((e) => entry.name.toLowerCase().endsWith(e))) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/** "1 problem", "2 problems". */
export const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
