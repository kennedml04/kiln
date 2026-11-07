import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { ArchiveBatch, ArchiveResetResponse, AuditEntry, Item, KilnEvent, Project } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';

const CORE_MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const epicFile = (title: string, stage: string) => `---\ntitle: ${title}\nstage: ${stage}\n---\nAbout ${title}.\n`;
const ticketFile = (n: string, title: string, stage: string) => `# ${n}: ${title}\n\n**Stage:** ${stage}\n`;

/** A Project with two shipped Epics and a live one, plus a Story at Tickets with one shipped Ticket and one live. */
async function setUp(kiln: TestKiln) {
  writeRepoFile(kiln.repo, '.scratch/epics/alpha.md', epicFile('Alpha shipped', 'shipped'));
  writeRepoFile(kiln.repo, '.scratch/epics/beta.md', epicFile('Beta shipped', 'shipped'));
  writeRepoFile(kiln.repo, '.scratch/epics/gamma.md', epicFile('Gamma live', 'roadmap'));
  writeRepoFile(kiln.repo, '.scratch/live/story.md', '---\ntitle: Live story\nstage: tickets\n---\nLive.\n');
  writeRepoFile(kiln.repo, '.scratch/live/issues/01-done.md', ticketFile('01', 'Done ticket', 'shipped'));
  writeRepoFile(kiln.repo, '.scratch/live/issues/02-todo.md', ticketFile('02', 'Todo ticket', 'implementing'));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Items');
  return kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
}

const items = (kiln: TestKiln) => kiln.api<Item[]>('GET', '/api/items');
const byKey = async (kiln: TestKiln, key: string) => {
  const item = (await items(kiln)).find((i) => i.key === key);
  assert.ok(item, `no Item ${key}`);
  return item;
};
const archivedKeys = async (kiln: TestKiln) => (await items(kiln)).filter((i) => i.archived).map((i) => i.key).sort();
const until = async <T>(fn: () => Promise<T | undefined | false>, what: string): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
const history = (kiln: TestKiln, query = '') => kiln.api<{ batches: ArchiveBatch[] }>('GET', `/api/archive${query}`).then((r) => r.batches);
const audit = (kiln: TestKiln, action: string) => kiln.api<AuditEntry[]>('GET', '/api/audit?limit=1000').then((all) => all.filter((e) => e.action === action));

test('Reset archives shipped Items, undo by batch puts back exactly that batch', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await setUp(kiln);
  const events = await kiln.events();
  const first = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', { projectId: project.id });
  assert.equal(first.count, 3);
  assert.deepEqual(await archivedKeys(kiln), ['epic/alpha', 'epic/beta', 'ticket/live/01']);
  await events.next('archive.reset');
  // The live Story's Ticket count is unchanged.
  assert.equal((await byKey(kiln, 'story/live')).childIds.length, 2);

  // A second Reset has nothing new to archive.
  assert.equal((await kiln.request('POST', '/api/archive/reset', { projectId: project.id })).status, 409);

  // Gamma ships by a Tracker edit, then a second Reset archives only it.
  writeRepoFile(kiln.repo, '.scratch/epics/gamma.md', epicFile('Gamma live', 'shipped'));
  await until(async () => (await byKey(kiln, 'epic/gamma')).runState === 'shipped', 'gamma shipped');
  const second = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', {});
  assert.deepEqual(second.itemIds, [`${project.id}/epic/gamma`]);

  const undone = await kiln.api<{ itemIds: string[] }>('POST', '/api/archive/unarchive', { batchId: first.batchId });
  assert.deepEqual(undone.itemIds.sort(), [...first.itemIds].sort());
  assert.deepEqual(await archivedKeys(kiln), ['epic/gamma']);
  assert.equal((await byKey(kiln, 'epic/alpha')).runState, 'shipped');
  const [entry] = await audit(kiln, 'archive.unarchive');
  assert.equal((entry!.detail as { count: number }).count, 3);
});

test('single Unarchive, then Reset again archives it into a new batch; history lists batches newest first', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await setUp(kiln);
  const first = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', { projectId: project.id });
  const alpha = `${project.id}/epic/alpha`;
  const events = await kiln.events();
  const put = await kiln.api<{ itemIds: string[] }>('POST', '/api/archive/unarchive', { itemIds: [alpha, 'nope/none'] });
  assert.deepEqual(put.itemIds, [alpha]);
  const updated = await events.next<KilnEvent<'item.updated', { item: Item }>>('item.updated');
  assert.equal(updated.payload.item.archived, undefined);
  await events.next('archive.unarchived');

  const [batch] = await history(kiln);
  assert.equal(batch!.count, 3);
  assert.equal(batch!.items.length, 2);

  const second = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', {});
  assert.deepEqual(second.itemIds, [alpha]);
  const batches = await history(kiln);
  assert.deepEqual(batches.map((b) => b.id), [second.batchId, first.batchId]);
  assert.deepEqual(batches.map((b) => b.items.length), [1, 2]);

  // Filters: Project, then title or key (case-insensitive).
  assert.equal((await history(kiln, '?projectId=other')).length, 0);
  assert.equal((await history(kiln, `?projectId=${project.id}`)).length, 2);
  const byTitle = await history(kiln, '?q=BETA');
  assert.deepEqual(byTitle.map((b) => b.items.map((i) => i.key)), [['epic/beta']]);
  const byKeyQ = await history(kiln, '?q=ticket/live');
  assert.deepEqual(byKeyQ.map((b) => b.items.map((i) => i.key)), [['ticket/live/01']]);
  assert.equal((await history(kiln, '?q=nothing-like-this')).length, 0);

  // Bad requests.
  assert.equal((await kiln.request('POST', '/api/archive/unarchive', {})).status, 400);
  assert.equal((await kiln.request('POST', '/api/archive/unarchive', { batchId: first.batchId, itemIds: [] })).status, 400);
  assert.equal((await kiln.request('POST', '/api/archive/unarchive', { batchId: 'nope' })).status, 404);
});

test('history skips Items gone from the Tracker', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await setUp(kiln);
  await kiln.api('POST', '/api/archive/reset', { projectId: project.id });
  kiln.repo.git('rm', '-q', '.scratch/epics/beta.md');
  await until(async () => !(await items(kiln)).some((i) => i.key === 'epic/beta'), 'beta removed');
  const [batch] = await history(kiln);
  assert.deepEqual(batch!.items.map((i) => i.key).sort(), ['epic/alpha', 'ticket/live/01']);
  assert.equal(batch!.count, 3);
});

/** Starts a second core on the stopped one's data folder; returns its URL. */
async function startAgain(kiln: TestKiln): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [CORE_MAIN, '--port', '0', '--data-dir', kiln.dataDir, '--login', 'local', '--test-mode'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, KILN_TEST_SETUP_DONE: '1', KILN_TAILSCALE_CLI: 'kiln-test-no-tailscale' },
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const port = await new Promise<number>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const m = JSON.parse(line) as { kiln?: string; port?: number };
        if (m.kiln === 'ready' && m.port) resolve(m.port);
      } catch {
        // not a protocol line
      }
    });
    child.once('exit', () => reject(new Error('core exited early')));
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await fetch(`${url}/api/core/stop`, { method: 'POST' }).catch(() => undefined);
    await exited;
  };
  return { url, stop };
}

test('the clearing rule: an archived Item that leaves Shipped loses its mark, also when found out at restart', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await setUp(kiln);
  await kiln.api('POST', '/api/archive/reset', { projectId: project.id });
  const events = await kiln.events();

  writeRepoFile(kiln.repo, '.scratch/epics/alpha.md', epicFile('Alpha shipped', 'roadmap'));
  const cleared = await until(async () => {
    const e = await events.next<KilnEvent<'item.updated', { item: Item }>>('item.updated', { timeoutMs: 3000 }).catch(() => undefined);
    return e && e.payload.item.key === 'epic/alpha' && e.payload.item.archived === undefined ? e : undefined;
  }, 'alpha updated');
  assert.equal(cleared.payload.item.runState, 'backlog');
  assert.equal((await byKey(kiln, 'epic/alpha')).archived, undefined);
  const [entry] = await audit(kiln, 'archive.cleared');
  assert.equal(entry!.actor.kind, 'kiln');
  assert.equal(entry!.target, `item:${project.id}/epic/alpha`);
  assert.deepEqual(await archivedKeys(kiln), ['epic/beta', 'ticket/live/01']);

  // Stop the core, edit the Tracker while it is down, start it again on the same data folder.
  await kiln.stop();
  writeRepoFile(kiln.repo, '.scratch/epics/beta.md', epicFile('Beta shipped', 'roadmap'));
  const again = await startAgain(kiln);
  const url = again.url;
  try {
  const list = async () => (await fetch(`${url}/api/items`).then((r) => r.json())) as Item[];
  await until(async () => {
    const b = (await list()).find((i) => i.key === 'epic/beta');
    return b && b.runState !== 'shipped' && !b.archived;
  }, 'beta cleared at start');
  assert.ok((await list()).find((i) => i.key === 'ticket/live/01')?.archived, 'a still-shipped Item stays archived over a restart');
  const log = (await fetch(`${url}/api/audit?limit=1000`).then((r) => r.json())) as AuditEntry[];
  assert.equal(log.filter((e) => e.action === 'archive.cleared').length, 2);
  } finally {
    await again.stop();
  }
});

test('archiving changes no run state, no file and no commit', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await setUp(kiln);
  const head = kiln.repo.git('rev-parse', 'HEAD');
  const before = await items(kiln);
  const { batchId } = await kiln.api<ArchiveResetResponse>('POST', '/api/archive/reset', { projectId: project.id });
  const during = await items(kiln);
  const shape = (all: Item[]) => all.map((i) => [i.id, i.runState, i.stage, i.childIds]);
  assert.deepEqual(shape(during), shape(before));
  await kiln.api('POST', '/api/archive/unarchive', { batchId });
  assert.equal(kiln.repo.git('rev-parse', 'HEAD'), head);
  assert.equal(kiln.repo.git('status', '--porcelain').trim(), '');
});

test('roles and audit: Viewers read the history but cannot reset or unarchive', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer', name: 'Vic' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member', name: 'Mo' });
  const project = await setUp(kiln);
  const vic = kiln.as('vic');
  const mo = kiln.as('mo');
  assert.equal((await vic.request('POST', '/api/archive/reset', {})).status, 403);
  assert.equal((await vic.request('POST', '/api/archive/unarchive', { itemIds: [] })).status, 403);
  assert.equal((await vic.request('GET', '/api/archive')).status, 200);

  assert.equal((await mo.request('POST', '/api/archive/reset', { projectId: 'nope' })).status, 404);
  const done = await mo.request<ArchiveResetResponse>('POST', '/api/archive/reset', { projectId: project.id });
  assert.equal(done.status, 200);
  await mo.api('POST', '/api/archive/unarchive', { batchId: done.body.batchId });

  const resets = (await audit(kiln, 'archive.reset')).filter((e) => e.outcome === 'allowed');
  assert.equal(resets.length, 1);
  assert.equal(resets[0]!.actor.kind === 'user' && resets[0]!.actor.id, 'mo');
  assert.equal(resets[0]!.target, `project:${project.id}`);
  assert.deepEqual(resets[0]!.detail, { batchId: done.body.batchId, count: 3 });
  assert.equal((await audit(kiln, 'archive.reset')).filter((e) => e.outcome === 'refused').length, 1);
  assert.equal((await audit(kiln, 'archive.unarchive')).filter((e) => e.outcome === 'allowed').length, 1);
});
