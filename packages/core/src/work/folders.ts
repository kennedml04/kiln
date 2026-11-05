// The folder browser (`GET /api/fs/folders`, Admin only): lists folders under the browse roots, so a
// person picks a Project folder (or the Knowledge store) by clicking, from any device.
//
// It never leaves the roots: a path must sit under one, with no junction or symlink on the way down,
// and the listing skips junctions, hidden folders and system folders. It only reads folder names.
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FolderEntry, FolderListing } from '@kiln/widget-sdk';
import { WorkError } from './work.ts';

/** System folders Windows (and other systems) keep that are never a Project. Compared in lower case. */
const SYSTEM_FOLDERS = new Set([
  'system volume information',
  'recovery',
  'config.msi',
  'perflogs',
  'appdata',
  'application data',
  'local settings',
  'node_modules',
  'lost+found',
]);

/** Hidden (a leading dot) or a system folder (a leading `$`, or one of SYSTEM_FOLDERS). */
const skipped = (name: string) => name.startsWith('.') || name.startsWith('$') || SYSTEM_FOLDERS.has(name.toLowerCase());

const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The path of `child` below `root`, as segments; undefined when it isn't under it. */
const below = (root: string, child: string): string[] | undefined => {
  const rel = relative(root, child);
  if (rel === '') return [];
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).filter(Boolean);
};

const isDir = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

export interface FolderBrowserDeps {
  /** The browse roots now, absolute. */
  roots(): string[];
  /** The registered Projects' folders. */
  registered(): string[];
}

export interface FolderBrowser {
  list(path?: string): FolderListing;
}

export function createFolderBrowser(deps: FolderBrowserDeps): FolderBrowser {
  const entry = (path: string, name: string, registered: string[]): FolderEntry => ({
    name,
    path,
    git: existsSync(join(path, '.git')),
    registered: registered.some((p) => same(resolve(p), path)),
    tracker: isDir(join(path, '.scratch')),
  });

  const outside = (path: string) => new WorkError(403, `${path} is outside the browse roots. An Admin adds roots in Settings.`);

  return {
    list(path) {
      const roots = deps.roots().map((r) => resolve(r));
      const registered = deps.registered();
      if (path === undefined || path === '') {
        return { roots, folders: roots.filter((r) => existsSync(r)).map((r) => entry(r, r, registered)) };
      }
      if (!isAbsolute(path)) throw outside(path);
      const target = resolve(path);
      // The deepest root it sits under, and no junction or symlink between that root and it.
      let root: string | undefined;
      let segments: string[] | undefined;
      for (const r of roots) {
        const found = below(r, target) ?? (same(r, target) ? [] : undefined);
        if (found && (!segments || found.length < segments.length)) {
          root = r;
          segments = found;
        }
      }
      if (root === undefined || segments === undefined) throw outside(target);
      let at = root;
      for (const segment of segments) {
        at = join(at, segment);
        if (!existsSync(at)) throw new WorkError(404, `No folder at ${target}`);
        if (lstatSync(at).isSymbolicLink()) throw outside(target);
      }
      if (!existsSync(target) || !statSync(target).isDirectory()) throw new WorkError(404, `No folder at ${target}`);
      let names: string[];
      try {
        names = readdirSync(target, { withFileTypes: true })
          // A junction or symlink reads as one, not as a directory: it is never followed.
          .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !skipped(d.name))
          .map((d) => d.name);
      } catch (err) {
        throw new WorkError(403, `Kiln cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      const isRoot = roots.some((r) => same(r, target));
      return {
        roots,
        path: target,
        ...(isRoot ? {} : { parent: dirname(target) }),
        folders: names.map((name) => entry(join(target, name), name, registered)),
      };
    },
  };
}
