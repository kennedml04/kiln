// The folder browser (`GET /api/fs/folders`) and the git check on registering a Project
// (project-wizard ticket 01). Every folder here is a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FolderListing, Project } from '@kiln/widget-sdk';
import { createTempRepo, startTestKiln, tempDir, type Cleanup } from '@kiln/testing';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Kiln Test', '-c', 'user.email=test@kiln.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A git repo with one commit on main, at `path`. */
const makeRepo = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), '# Repo\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'First');
};

const folders = (path?: string) => `/api/fs/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`;

/**
 * A browse root holding: `alpha` (a repo with a .scratch tracker), `beta` (a plain folder with a
 * child), `.hidden`, `$RECYCLE.BIN`, and `link`, a junction to a folder outside the root.
 */
function browseTree(t: Cleanup) {
  const root = tempDir(t, 'kiln-browse');
  const outside = tempDir(t, 'kiln-outside');
  mkdirSync(join(outside, 'secret'));
  makeRepo(join(root, 'alpha'));
  mkdirSync(join(root, 'alpha', '.scratch'));
  mkdirSync(join(root, 'beta', 'child'), { recursive: true });
  mkdirSync(join(root, '.hidden'));
  mkdirSync(join(root, '$RECYCLE.BIN'));
  writeFileSync(join(root, 'notes.txt'), 'a file, not a folder');
  symlinkSync(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  return { root, outside };
}

test('the folder listing is Admin-only', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  assert.equal((await kiln.as('mo').request('GET', folders())).status, 403);
  assert.equal((await kiln.request('GET', folders())).status, 200);
});

test('with no browse roots set, the listing offers nothing', async (t) => {
  const kiln = await startTestKiln(t);
  const listing = await kiln.api<FolderListing>('GET', folders());
  assert.deepEqual(listing.roots, []);
  assert.deepEqual(listing.folders, []);
});

test('the listing shows the roots, then each folder with whether it is a repo, registered, or has a .scratch tracker; hidden, system and junction folders are skipped', async (t) => {
  const kiln = await startTestKiln(t);
  const { root } = browseTree(t);
  await kiln.api('PUT', '/api/setup', { browseRoots: [root] });
  await kiln.api<Project>('POST', '/api/projects', { path: join(root, 'alpha') });

  const top = await kiln.api<FolderListing>('GET', folders());
  assert.deepEqual(top.roots, [root]);
  assert.deepEqual(top.folders.map((f) => f.path), [root]);

  const listing = await kiln.api<FolderListing>('GET', folders(root));
  assert.equal(listing.path, root);
  assert.equal(listing.parent, undefined, 'a root has no parent to go up to');
  assert.deepEqual(
    listing.folders.map((f) => ({ name: f.name, git: f.git, registered: f.registered, tracker: f.tracker })),
    [
      { name: 'alpha', git: true, registered: true, tracker: true },
      { name: 'beta', git: false, registered: false, tracker: false },
    ],
  );
  assert.equal(listing.folders[0]!.path, join(root, 'alpha'));

  const beta = await kiln.api<FolderListing>('GET', folders(join(root, 'beta')));
  assert.equal(beta.parent, root);
  assert.deepEqual(beta.folders.map((f) => f.name), ['child']);
});

test('the listing stays inside the roots and never goes through a junction', async (t) => {
  const kiln = await startTestKiln(t);
  const { root, outside } = browseTree(t);
  await kiln.api('PUT', '/api/setup', { browseRoots: [root] });

  for (const path of [outside, join(root, '..'), join(root, 'link'), join(root, 'link', 'secret'), 'relative\\path']) {
    const res = await kiln.request<{ error: string }>('GET', folders(path));
    assert.equal(res.status, 403, `${path} answered ${res.status}`);
    assert.match(res.body.error, /browse roots/);
  }
  assert.equal((await kiln.request('GET', folders(join(root, 'missing')))).status, 404);
});

test('the Projects folder is always a browse root once it is set', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  const other = tempDir(t, 'kiln-other');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects, browseRoots: [other] });

  const listing = await kiln.api<FolderListing>('GET', folders());
  assert.deepEqual(listing.roots, [projects, other]);
  assert.equal((await kiln.request('GET', folders(projects))).status, 200);
});

test('browse roots must be absolute folders that exist', async (t) => {
  const kiln = await startTestKiln(t);
  const root = tempDir(t, 'kiln-browse');
  assert.equal((await kiln.request('PUT', '/api/setup', { browseRoots: ['relative'] })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/setup', { browseRoots: [join(root, 'missing')] })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/setup', { browseRoots: 'not a list' })).status, 400);
});

test('on a dev instance, the browser offers only the dev data folder', async (t) => {
  const kiln = await startTestKiln(t, { devInstance: true });
  const root = tempDir(t, 'kiln-browse');
  await kiln.api('PUT', '/api/setup', { browseRoots: [root] });

  const listing = await kiln.api<FolderListing>('GET', folders());
  assert.deepEqual(listing.roots, [kiln.dataDir]);
  assert.equal((await kiln.request('GET', folders(root))).status, 403);
  assert.equal((await kiln.request('GET', folders(kiln.dataDir))).status, 200);
});

test('a folder that is not a git repo is refused with the offer to initialise it, and Initialise makes a first commit and registers it', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = tempDir(t, 'kiln-plain');
  writeFileSync(join(dir, 'plan.md'), '# A plan\n');

  const refused = await kiln.request<{ error: string; reason: string }>('POST', '/api/projects', { path: dir });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'not-a-repo');
  assert.match(refused.body.error, /is not a git repo/);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: dir, init: true });
  assert.equal(project.path, dir);
  assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  // The first commit holds what the folder had, as Kiln (registering then adds the Project Policy template).
  const first = git(dir, 'rev-list', '--max-parents=0', 'HEAD').trim();
  assert.equal(first.split('\n').length, 1);
  assert.equal(git(dir, 'log', '-1', '--format=%an %s', first).trim(), 'Kiln Initial commit');
  assert.match(git(dir, 'ls-tree', '--name-only', first), /plan\.md/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a repo with no commits is refused with the fix spelled out', async (t) => {
  const kiln = await startTestKiln(t);
  const dir = tempDir(t, 'kiln-empty');
  git(dir, 'init', '-q', '-b', 'main');

  const refused = await kiln.request<{ error: string; reason: string }>('POST', '/api/projects', { path: dir });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'no-commits');
  assert.match(refused.body.error, /no commits/);
  assert.match(refused.body.error, /git commit/);
  // Initialise is only for folders that aren't repos: Kiln doesn't commit into someone's empty repo.
  assert.equal((await kiln.request('POST', '/api/projects', { path: dir, init: true })).status, 409);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
});

test('a repo off its default branch is refused, and Kiln does not switch branches', async (t) => {
  const kiln = await startTestKiln(t);
  const repo = createTempRepo(t);
  repo.git('checkout', '-q', '-b', 'my-experiment');

  const refused = await kiln.request<{ error: string; reason: string }>('POST', '/api/projects', { path: repo.path });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'off-default-branch');
  assert.match(refused.body.error, /my-experiment/);
  assert.match(refused.body.error, /git switch main/);
  assert.equal(repo.git('symbolic-ref', '--short', 'HEAD').trim(), 'my-experiment');

  repo.git('checkout', '-q', 'main');
  assert.equal((await kiln.request('POST', '/api/projects', { path: repo.path })).status, 201);
});

test('a folder inside a repo, not at its top, is refused and names the top', async (t) => {
  const kiln = await startTestKiln(t);
  const repo = createTempRepo(t);
  mkdirSync(join(repo.path, 'sub'));

  const refused = await kiln.request<{ error: string; reason: string }>('POST', '/api/projects', { path: join(repo.path, 'sub'), init: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'not-repo-top');
  assert.match(refused.body.error, /top of its repo/);
});
