// + Project → New (project-wizard ticket 02): `POST /api/projects/new` makes a Project in the
// Projects folder, commits it once as Kiln, registers it and opens a grill-stage Story. Every
// folder here is a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, NewProjectResult, Project } from '@kiln/widget-sdk';
import { startTestKiln, tempDir } from '@kiln/testing';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const DESCRIPTION = 'A bracket that holds the router under the desk.';

test('New is Admin-only', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const res = await kiln.as('mo').request('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(res.status, 403);
});

test('with no Projects folder set, New is refused with a reason the wizard asks it from', async (t) => {
  const kiln = await startTestKiln(t);
  const res = await kiln.request<{ error: string; reason?: string }>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'no-projects-folder');
  assert.match(res.body.error, /Projects folder/);
});

test('New makes the folder, one first commit as Kiln, the Project, and a "What we\'re building" Story at grill', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });

  const result = await kiln.api<NewProjectResult>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  const folder = join(projects, 'desk-bracket');

  // The folder, its files and its repo.
  assert.equal(result.project.path.toLowerCase(), folder.toLowerCase());
  assert.equal(result.project.name, 'desk-bracket');
  assert.match(readFileSync(join(folder, 'README.md'), 'utf8'), /^# desk-bracket\n\nA bracket that holds the router under the desk\.\n/);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, '.kiln', 'settings.json'), 'utf8')), { tracker: 'markdown' });
  assert.ok(existsSync(join(folder, '.gitignore')));
  assert.equal(git(folder, 'branch', '--show-current').trim(), 'main');

  // The first commit: README, settings and .gitignore, as the install's git identity, no trailer.
  const root = git(folder, 'rev-list', '--max-parents=0', 'HEAD').trim();
  assert.deepEqual(git(folder, 'show', '--name-only', '--format=', root).trim().split('\n').sort(), ['.gitignore', '.kiln/settings.json', 'README.md']);
  assert.equal(git(folder, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', root).trim(), 'Kiln <kiln@localhost>|Kiln <kiln@localhost>');
  const message = git(folder, 'log', '-1', '--format=%B', root);
  assert.equal(message.trim(), 'New Project: desk-bracket');
  assert.equal(execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' }).trim(), '');
  assert.doesNotMatch(message, /co-authored-by/i);
  // The same identity Kiln commits Tracker records as.
  const storyCommit = git(folder, 'log', '-1', '--format=%an <%ae>', '--', '.scratch').trim();
  assert.equal(storyCommit, 'Kiln <kiln@localhost>');

  // The Project and its first Story.
  const registered = await kiln.api<Project[]>('GET', '/api/projects');
  assert.deepEqual(registered.map((p) => p.id), [result.project.id]);
  const items = await kiln.api<Item[]>('GET', `/api/projects/${result.project.id}/items`);
  assert.equal(items.length, 1);
  const story = items[0]!;
  assert.equal(story.id, result.item.id);
  assert.equal(story.kind, 'story');
  assert.equal(story.title, "What we're building");
  assert.equal(story.stage, 'grill');
  assert.match(story.description ?? '', /A bracket that holds the router under the desk\./);
});

test('names that are not one folder name are refused, as is a folder that already holds other files', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });

  for (const name of ['', '  ', '..', 'a/b', 'a\\b', 'what?', 'con']) {
    const res = await kiln.request('POST', '/api/projects/new', { name, description: DESCRIPTION });
    assert.equal(res.status, 400, `the name ${JSON.stringify(name)} is refused`);
  }
  const twoLines = await kiln.request('POST', '/api/projects/new', { name: 'ok', description: 'one\ntwo' });
  assert.equal(twoLines.status, 400, 'the description is one line');

  mkdirSync(join(projects, 'taken'));
  writeFileSync(join(projects, 'taken', 'notes.txt'), 'mine');
  const taken = await kiln.request<{ error: string }>('POST', '/api/projects/new', { name: 'taken', description: DESCRIPTION });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already holds/);
  assert.equal(readFileSync(join(projects, 'taken', 'notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), []);
});

test('a failure partway names its step and leaves the folder unregistered; a retry finishes the job', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });
  const folder = join(projects, 'desk-bracket');
  // A broken `.git` file: the folder and its files can be made, but git init fails.
  mkdirSync(folder);
  writeFileSync(join(folder, '.git'), 'gitdir: ./nowhere\n');

  const failed = await kiln.request<{ error: string; step?: string }>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.step, 'git');
  assert.match(failed.body.error, /^Step 3 of 5 \(git init and the first commit\) failed: /);
  assert.ok(existsSync(join(folder, 'README.md')), 'the steps before it are left in place');
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), [], 'nothing is registered');

  // The person fixes the cause and tries again: New carries on from the failed step.
  writeFileSync(join(folder, 'README.md'), '# desk-bracket\n\nEdited by hand.\n');
  rmSync(join(folder, '.git'));
  const result = await kiln.api<NewProjectResult>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(readFileSync(join(folder, 'README.md'), 'utf8'), '# desk-bracket\n\nEdited by hand.\n', 'files already written are kept');
  assert.equal(git(folder, 'rev-list', '--count', '--max-parents=0', 'HEAD').trim(), '1');
  assert.equal(result.item.stage, 'grill');
  assert.equal((await kiln.api<Project[]>('GET', '/api/projects')).length, 1);

  // Asking again for a Project that is done is refused, and makes nothing twice.
  const again = await kiln.request<{ error: string }>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already registered/);
  assert.equal((await kiln.api<Item[]>('GET', `/api/projects/${result.project.id}/items`)).length, 1);
});

test('a Story that cannot be written fails at step 5 and unregisters the Project; a retry registers it and writes the Story', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });
  const folder = join(projects, 'desk-bracket');
  // `.scratch` as a file: everything up to registering works, the Tracker can't write the Story.
  mkdirSync(folder);
  writeFileSync(join(folder, '.scratch'), 'not a folder');

  const failed = await kiln.request<{ error: string; step?: string }>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(failed.body.step, 'story');
  assert.match(failed.body.error, /^Step 5 of 5 \(create the "What we're building" Story\) failed: /);
  assert.deepEqual(await kiln.api<Project[]>('GET', '/api/projects'), [], 'the Project is left unregistered');
  assert.equal(git(folder, 'rev-list', '--count', 'HEAD').trim() !== '0', true, 'the first commit stays');

  rmSync(join(folder, '.scratch'));
  const result = await kiln.api<NewProjectResult>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(result.item.title, "What we're building");
  assert.equal(result.item.stage, 'grill');
  assert.equal(git(folder, 'rev-list', '--count', '--max-parents=0', 'HEAD').trim(), '1');
  assert.equal((await kiln.api<Item[]>('GET', `/api/projects/${result.project.id}/items`)).length, 1);
});

test('a name the Projects folder cannot hold fails at step 1 and names it', async (t) => {
  const kiln = await startTestKiln(t);
  const projects = tempDir(t, 'kiln-projects');
  await kiln.api('PUT', '/api/setup', { projectsFolder: projects });
  writeFileSync(join(projects, 'desk-bracket'), 'a file, not a folder');

  const failed = await kiln.request<{ error: string; step?: string }>('POST', '/api/projects/new', { name: 'desk-bracket', description: DESCRIPTION });
  assert.equal(failed.body.step, 'folder');
  assert.match(failed.body.error, /^Step 1 of 5 \(make the folder\) failed: /);
});
