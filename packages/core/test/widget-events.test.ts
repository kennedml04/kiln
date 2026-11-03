import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEntry, ItemUpdatedEvent, KilnEvent, Manifest, Project } from '@kiln/widget-sdk';
import { createTempRepo, createWidgetSource, driveTestWidget, startTestKiln, type Cleanup, type TestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const startWidget = async (t: Cleanup, kiln: TestKiln, manifest: Partial<Manifest>) => {
  const source = createWidgetSource(t, { manifest });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
  return driveTestWidget(kiln, source.manifest.id);
};

const STORY = '.scratch/home-board/story.md';
const editStory = (repo: { path: string; git(...args: string[]): string }) =>
  writeRepoFile(repo, STORY, readRepoFile(repo, STORY).replace('stage: spec', 'stage: tickets'));

test('a Widget receives the Work events it subscribed to, only for Projects its grants cover', async (t) => {
  const kiln = await startTestKiln(t);
  const other = createTempRepo(t);
  seedScratch(kiln.repo);
  seedScratch(other);
  const mine = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const theirs = await kiln.api<Project>('POST', '/api/projects', { path: other.path });
  const widget = await startWidget(t, kiln, { needs: { work: [{ access: 'read', projects: [mine.id] }] } });
  assert.equal((await widget.subscribe(['item.updated'])).status, 200);
  const shell = await kiln.events();

  editStory(other);
  const elsewhere = await shell.next<ItemUpdatedEvent>('item.updated');
  assert.equal(elsewhere.payload.item.projectId, theirs.id);
  editStory(kiln.repo);
  await shell.next('item.updated');

  const received = await widget.nextReceived((e) => e.type === 'item.updated');
  assert.equal((received as ItemUpdatedEvent).payload.item.projectId, mine.id);
  assert.deepEqual(
    widget.received().map((e) => [e.type, (e as ItemUpdatedEvent).payload.item.projectId]),
    [['item.updated', mine.id]],
    'nothing from the Project it was not granted',
  );
});

test('a Widget is refused events its grants do not allow, and may always follow Widget health', async (t) => {
  const kiln = await startTestKiln(t);
  const widget = await startWidget(t, kiln, { needs: {} });

  const work = await widget.subscribe(['item.updated']);
  assert.equal(work.status, 403);
  assert.equal((work.body as { reason: string }).reason, 'grant');
  assert.equal((await widget.subscribe(['audit.recorded'])).status, 403, 'not an event Widgets can subscribe to');
  assert.equal((await widget.subscribe(['agent.progress'])).status, 403);
  const refused = (await kiln.api<AuditEntry[]>('GET', '/api/audit')).filter(
    (e) => e.actor.kind === 'widget' && e.outcome === 'refused' && e.reason === 'grant',
  );
  assert.equal(refused.length, 3, 'every refused subscription is audited');
  assert.deepEqual(refused.at(-1)?.detail, { types: ['item.updated'] });

  assert.equal((await widget.subscribe(['widget.ready', 'widget.unhealthy'])).status, 200);
  await startWidget(t, kiln, { id: 'second' });
  const ready = await widget.nextReceived((e: KilnEvent) => e.type === 'widget.ready');
  assert.deepEqual(ready.payload, { widgetId: 'second' });
  assert.equal((await kiln.request('GET', '/api/widget/events?types=widget.ready')).status, 401, 'needs a Widget credential');
});
