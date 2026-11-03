// Widget sources: resolving an install request to exact code, and the Org Policy's source check.
//
// A git source (a URL, or a local folder with `.git` at its root) is cloned into the data folder at
// one exact commit, so nothing in the source can change what runs. Any other local folder runs in
// place and is pinned to a hash of its files; the lifecycle refuses to start it if the hash moves.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Manifest, WidgetPin, WidgetSourcePolicy } from '@kiln/widget-sdk';
import { removeFolder } from '../exec.ts';
import { gitSync } from '../flow/git.ts';
import { readManifest, WidgetHostError } from '../widget-host.ts';

export interface ResolvedWidget {
  pin: WidgetPin;
  /** Where the Widget's code is: its folder in the clone, or the source folder itself. */
  folder: string;
  manifest: Manifest;
}

const isUrl = (source: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || /^[^@\s/\\]+@[^:\s]+:/.test(source);

/** The source as Kiln records it: URLs as given, local paths made absolute. */
export const normalizeSource = (source: string) => (isUrl(source) ? source : resolve(source));

const isGitSource = (source: string) => isUrl(source) || existsSync(join(source, '.git'));

const git = (cwd: string, ...args: string[]) => gitSync(cwd, '-c', 'core.autocrlf=false', ...args).trim();

const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
};

/** Removes a staging folder in the background; a leftover one is harmless. */
const rmQuietly = (path: string) => void removeFolder(path).catch(() => undefined);

/** The Widget folder inside a checkout, refusing a `path` that climbs out of it. */
function widgetFolder(root: string, path: string | undefined): string {
  const folder = resolve(root, path ?? '.');
  if (folder !== root && !folder.startsWith(root + sep)) throw new WidgetHostError(400, `path "${path}" is outside the source`);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new WidgetHostError(400, `No folder "${path ?? '.'}" in the source`);
  return folder;
}

/** `sha256:<hex>` over every file's relative path and bytes, skipping `.git` and `node_modules`. */
export function hashFolder(folder: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(`${relative(folder, path).split(sep).join('/')}\0`).update(readFileSync(path)).update('\0');
    }
  };
  walk(folder);
  return `sha256:${hash.digest('hex')}`;
}

function resolveGit(source: string, ref: string | undefined, path: string | undefined, codeRoot: string): ResolvedWidget {
  const staging = join(codeRoot, '.staging', randomBytes(6).toString('hex'));
  mkdirSync(join(codeRoot, '.staging'), { recursive: true });
  try {
    try {
      git(codeRoot, 'clone', '-q', '--no-checkout', source, staging);
    } catch (err) {
      throw new WidgetHostError(400, `Could not clone ${source}: ${String((err as { stderr?: string }).stderr ?? err).trim()}`);
    }
    const candidates = ref ? [ref, `origin/${ref}`] : ['HEAD'];
    const commit = candidates.map((c) => tryGit(staging, 'rev-parse', '--verify', '--quiet', `${c}^{commit}`)).find(Boolean);
    if (!commit) throw new WidgetHostError(400, `No commit "${ref ?? 'HEAD'}" in ${source}`);
    git(staging, 'checkout', '-q', '--detach', commit);
    const tag = tryGit(staging, 'tag', '--points-at', commit)?.split('\n').find(Boolean);
    const manifest = readManifest(widgetFolder(staging, path));
    // Each commit gets its own checkout, so an update never changes the code a running Widget uses.
    const checkout = join(codeRoot, manifest.id, 'code', commit);
    if (existsSync(checkout)) rmQuietly(staging);
    else {
      mkdirSync(join(codeRoot, manifest.id, 'code'), { recursive: true });
      renameSync(staging, checkout);
    }
    const pin: WidgetPin = { kind: 'git', source, commit };
    if (ref) pin.ref = ref;
    if (tag) pin.tag = tag;
    if (path) pin.path = path;
    return { pin, folder: widgetFolder(checkout, path), manifest };
  } finally {
    if (existsSync(staging)) rmQuietly(staging);
  }
}

function resolveFolder(source: string, path: string | undefined): ResolvedWidget {
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new WidgetHostError(400, `No folder ${source}`);
  const folder = widgetFolder(source, path);
  const manifest = readManifest(folder);
  const pin: WidgetPin = { kind: 'folder', source, hash: hashFolder(folder) };
  if (path) pin.path = path;
  return { pin, folder, manifest };
}

/**
 * Resolves a source to exact code. `codeRoot` is `<data dir>/widgets`; git checkouts go under
 * `<codeRoot>/<id>/code/<commit>`.
 */
export function resolveWidget(request: { source: string; ref?: string; path?: string }, codeRoot: string): ResolvedWidget {
  const source = normalizeSource(request.source);
  if (isGitSource(source)) return resolveGit(source, request.ref, request.path, codeRoot);
  if (request.ref) throw new WidgetHostError(400, `${source} is not a git repo, so it has no ref "${request.ref}"`);
  return resolveFolder(source, request.path);
}

const comparable = (source: string) => {
  const s = source.replace(/\\/g, '/');
  return process.platform === 'win32' && !isUrl(source) ? s.toLowerCase() : s;
};

/** Whether the Org Policy allows installing from this source. */
export function sourceAllowed(policy: WidgetSourcePolicy, source: string): boolean {
  if (policy.allowed === null) return true;
  const wanted = comparable(normalizeSource(source));
  return policy.allowed.some((entry) => {
    if (entry.endsWith('*')) return wanted.startsWith(comparable(entry.slice(0, -1)));
    const allowed = comparable(normalizeSource(entry)).replace(/\/+$/, '');
    return wanted === allowed || wanted.startsWith(`${allowed}/`);
  });
}
