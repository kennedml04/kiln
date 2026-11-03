import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, ItemCreatedEvent, ItemUpdatedEvent, Project, WorkSnapshotEvent } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  assert.ok(item, `no Item titled "${title}" in ${items.map((i) => i.title).join(', ')}`);
  return item;
};

test('registering a repo with an existing .scratch layout shows its Epics, Stories and Tickets with parents and children', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);

  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);

  const epic = byTitle(items, 'Board as home');
  const story = byTitle(items, 'Home board');
  const first = byTitle(items, 'Draw the columns');
  const second = byTitle(items, 'Live updates');
  assert.deepEqual(
    [epic, story, first, second].map((i) => [i.kind, i.stage]),
    [
      ['epic', 'roadmap'],
      ['story', 'spec'],
      ['ticket', 'implementing'],
      ['ticket', 'shipped'],
    ],
  );
  assert.equal(story.parentId, epic.id);
  assert.deepEqual(epic.childIds, [story.id]);
  assert.equal(first.parentId, story.id);
  assert.deepEqual(story.childIds, [first.id, second.id]);
  assert.equal(first.status, 'ready-for-agent');
  assert.equal(items.length, 4);
});

test('creating a Story and a Ticket writes them into the repo in the .scratch layout as Kiln commits', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const epic = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), 'Board as home');

  const story = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, {
    kind: 'story',
    title: 'Needs you inbox',
    parentId: epic.id,
    description: 'One inbox for every Ask.',
  });
  const ticket = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, {
    kind: 'ticket',
    title: 'Sort by blocked work',
    parentId: story.id,
    description: 'Most blocking first.',
  });

  assert.deepEqual([story.kind, story.stage, story.parentId], ['story', 'grill', epic.id]);
  assert.deepEqual([ticket.kind, ticket.stage, ticket.parentId], ['ticket', 'implementing', story.id]);
  assert.equal(
    readRepoFile(kiln.repo, '.scratch/needs-you-inbox/story.md'),
    '---\ntitle: Needs you inbox\nepic: board-as-home\nstage: grill\n---\n\nOne inbox for every Ask.\n',
  );
  assert.equal(
    readRepoFile(kiln.repo, '.scratch/needs-you-inbox/issues/01-sort-by-blocked-work.md'),
    '# 01: Sort by blocked work\n\n**What to build:** Most blocking first.\n\n**Blocked by:** None\n\n**Status:** needs-triage\n',
  );
  assert.equal(kiln.repo.git('status', '--porcelain'), '');
  assert.equal(kiln.repo.git('log', '-1', '--format=%an').trim(), 'Kiln');
});

test('a new Item is refused, and no file written, while the main checkout is off its default branch', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const epic = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), 'Board as home');
  kiln.repo.git('checkout', '-q', '-b', 'my-experiment');
  const head = kiln.repo.git('rev-parse', 'HEAD');

  await assert.rejects(
    kiln.api('POST', `/api/projects/${project.id}/items`, { kind: 'story', title: 'Needs you inbox', parentId: epic.id }),
    /409.*my-experiment.*not the default branch main/,
  );

  assert.equal(kiln.repo.git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(kiln.repo.git('rev-parse', 'HEAD'), head, 'Kiln committed nothing');
});

test('a Ticket needs a Story as its parent', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });

  await assert.rejects(
    kiln.api('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title: 'Orphan' }),
    /400/,
  );
});

test('moving an Item to another Stage by hand is refused and changes nothing', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const story = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), 'Home board');
  const before = readRepoFile(kiln.repo, '.scratch/home-board/story.md');

  await assert.rejects(
    kiln.api('PATCH', `/api/items/${encodeURIComponent(story.id)}`, { stage: 'shipped' }),
    /409.*Exit.*Gate/,
  );

  assert.equal(readRepoFile(kiln.repo, '.scratch/home-board/story.md'), before);
  const after = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), 'Home board');
  assert.equal(after.stage, 'spec');
});

test('a new event stream starts with every Project and Item, the same Items both board views read', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });

  const events = await kiln.events();
  const snapshot = await events.next<WorkSnapshotEvent>('work.snapshot');

  assert.deepEqual(snapshot.payload.projects.map((p) => p.id), [project.id]);
  assert.deepEqual(snapshot.payload.items, await kiln.api<Item[]>('GET', '/api/items'));
  assert.deepEqual(snapshot.payload.items, await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`));
  assert.deepEqual(
    snapshot.payload.projects[0]!.workflow.kinds.map((k) => [k.id, k.stages.map((s) => s.id).join(' > ')]),
    [
      ['epic', 'roadmap > shipped'],
      ['story', 'grill > spec > tickets > shipped'],
      ['ticket', 'implementing > review > shipped'],
    ],
  );
});

test('editing an Item file in the repo raises an update with the new Stage', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const events = await kiln.events();

  const story = readRepoFile(kiln.repo, '.scratch/home-board/story.md');
  writeRepoFile(kiln.repo, '.scratch/home-board/story.md', story.replace('stage: spec', 'stage: tickets'));

  const updated = await events.next<ItemUpdatedEvent>('item.updated');
  assert.equal(updated.payload.item.title, 'Home board');
  assert.equal(updated.payload.item.stage, 'tickets');
});

test('a Ticket file added to the repo appears as a new child of its Story', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const events = await kiln.events();

  writeRepoFile(
    kiln.repo,
    '.scratch/home-board/issues/03-drag-to-prioritise.md',
    '# 03: Drag to prioritise\n\n**Status:** needs-triage\n',
  );

  const created = await events.next<ItemCreatedEvent>('item.created');
  assert.equal(created.payload.item.title, 'Drag to prioritise');
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.ok(byTitle(items, 'Home board').childIds.includes(created.payload.item.id));
});
