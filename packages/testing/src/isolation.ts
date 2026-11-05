import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';

/** The live Kiln and the old board. No test may touch these. */
export const FORBIDDEN_PORTS = [8300, 8195];

/**
 * The live Kiln's data folders, plus any folder named in KILN_TEST_FORBIDDEN_FOLDERS (separated like
 * PATH). The repo names no other live folder: each PC lists its own (the old board's, say) there.
 */
export function forbiddenFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const folders = [join(homedir(), '.local', 'share', 'Kiln')];
  if (env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'Kiln'));
  for (const folder of (env.KILN_TEST_FORBIDDEN_FOLDERS ?? '').split(delimiter)) {
    if (folder.trim()) folders.push(folder.trim());
  }
  return folders;
}

const isInside = (path: string, folder: string) => {
  const p = resolve(path).toLowerCase();
  const f = resolve(folder).toLowerCase();
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
};

/** Throws if a test is about to use a live port or folder. */
export function assertIsolated(what: { port?: number; paths?: string[] }): void {
  if (what.port !== undefined && FORBIDDEN_PORTS.includes(what.port)) {
    throw new Error(`Test isolation: port ${what.port} belongs to a live board`);
  }
  for (const path of what.paths ?? []) {
    for (const folder of forbiddenFolders()) {
      if (isInside(path, folder)) throw new Error(`Test isolation: ${path} is inside live folder ${folder}`);
    }
  }
}
