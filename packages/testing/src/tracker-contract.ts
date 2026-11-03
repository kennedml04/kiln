// The shared Tracker contract: what every Tracker must do for Kiln, driven from outside through a
// real core. Each Tracker's tests call `trackerContract(backend)`; the backend puts the standard
// Item tree in its Tracker, registers a Project that uses it, and reads records back the way a
// person would (the files in the repo, the issues on GitHub), never through Kiln.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, ItemStageChangedEvent, ItemUpdatedEvent, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from './harness.ts';

/**
 * The standard tree every backend seeds:
 * - Epic "Board as home", Stage roadmap
 * - Story "Home board" under it, Stage spec
 * - Ticket "Draw the columns" under the Story, Stage implementing, Status ready-for-agent,
 *   what to build "One column per run state."
 * - Ticket "Live updates" under the Story, Stage shipped, Status done
 */
export const CONTRACT_TREE = {
  epic: 'Board as home',
  story: 'Home board',
  ready: 'Draw the columns',
  shipped: 'Live updates',
} as const;

/** What the Tracker itself holds for one Item, read from outside Kiln. */
export interface RecordedItem {
  title: string;
  kind: string;
  stage: string;
  status?: string;
  description?: string;
  /** The parent's title. */
  parent?: string;
}

export interface TrackerBackend {
  /** Names the tests: "<name> keeps the Tracker contract: …". */
  name: string;
  /** A reason to skip the whole contract (an opt-in run nobody asked for). */
  skip?: string | false;
  timeoutMs?: number;
  /**
   * Seeds the standard tree in the Tracker and registers a Project that uses it, with the test
   * command `node --version`. Resolves once Kiln shows the tree's four Items.
   */
  setUp(t: TestContext, kiln: TestKiln): Promise<Project>;
  /** The Tracker's own record of the Item with this title, or undefined when it has none. */
  recorded(title: string): Promise<RecordedItem | undefined>;
  /** Renames an Item in the Tracker from outside Kiln, the way a person would. */
  renameOutside(title: string, to: string): Promise<void>;
}

const byTitle = (items: Item[], title: string) => {
  const found = items.find((i) => i.title === title);
  assert.ok(found, `Kiln shows no Item titled "${title}" (it shows ${items.map((i) => `"${i.title}"`).join(', ') || 'none'})`);
  return found;
};

/** Waits until Kiln shows every title of the standard tree for this Project. */
export async function waitForItems(kiln: TestKiln, projectId: string, titles: string[], timeoutMs = 15_000): Promise<Item[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await kiln.api<Item[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/items`);
    if (titles.every((title) => items.some((i) => i.title === title))) return items;
    if (Date.now() > deadline) {
      throw new Error(`Kiln did not show ${titles.join(', ')} within ${timeoutMs}ms (it shows ${items.map((i) => i.title).join(', ') || 'none'})`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

export function trackerContract(backend: TrackerBackend): void {
  const options = { skip: backend.skip || false, timeout: backend.timeoutMs ?? 120_000 };
  const named = (what: string) => `${backend.name} keeps the Tracker contract: ${what}`;

  test(named("Kiln shows the Tracker's records as Items with their kinds, Stages, Statuses and parents"), options, async (t) => {
    const kiln = await startTestKiln(t);
    const project = await backend.setUp(t, kiln);
    const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
    const epic = byTitle(items, CONTRACT_TREE.epic);
    const story = byTitle(items, CONTRACT_TREE.story);
    const ready = byTitle(items, CONTRACT_TREE.ready);
    const shipped = byTitle(items, CONTRACT_TREE.shipped);
    assert.deepEqual([epic.kind, epic.stage, epic.parentId], ['epic', 'roadmap', undefined]);
    assert.deepEqual([story.kind, story.stage, story.parentId], ['story', 'spec', epic.id]);
    assert.deepEqual([ready.kind, ready.stage, ready.status, ready.parentId], ['ticket', 'implementing', 'ready-for-agent', story.id]);
    assert.deepEqual([shipped.kind, shipped.stage, shipped.runState, shipped.parentId], ['ticket', 'shipped', 'shipped', story.id]);
    assert.deepEqual([...story.childIds].sort(), [ready.id, shipped.id].sort());
    assert.match(ready.description ?? '', /One column per run state/);
  });

  test(named('a met Exit moves the Item on, and the Tracker records only its new Stage and Status'), options, async (t) => {
    const kiln = await startTestKiln(t);
    await kiln.installFakeAgent({
      script: {
        implementer: [
          { do: 'write', path: 'feature.txt', content: 'columns\n' },
          { do: 'commit', message: 'Draw the columns' },
        ],
        // The review Session after it is not part of this contract: it just waits.
        reviewer: [{ do: 'wait_for_message' }],
      },
    });
    const project = await backend.setUp(t, kiln);
    const before = await backend.recorded(CONTRACT_TREE.ready);
    assert.ok(before, 'the backend seeded the ready Ticket');
    const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.ready);
    const events = await kiln.events();

    await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
    const moved = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 30_000 });
    assert.deepEqual([moved.payload.itemId, moved.payload.from, moved.payload.to], [ticket.id, 'implementing', 'review']);

    const after = await backend.recorded(CONTRACT_TREE.ready);
    assert.deepEqual(after, { ...before, stage: 'review', status: 'in-review' });
  });

  test(named('an Item created through Kiln is written to the Tracker under its parent, in its kind\'s first Stage'), options, async (t) => {
    const kiln = await startTestKiln(t);
    const project = await backend.setUp(t, kiln);
    const story = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.story);

    const created = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, {
      kind: 'ticket',
      title: 'Sort the cards',
      parentId: story.id,
      description: 'Oldest first in each column.',
    });
    assert.deepEqual([created.kind, created.stage, created.parentId], ['ticket', 'implementing', story.id]);

    const recorded = await backend.recorded('Sort the cards');
    assert.ok(recorded, 'the Tracker holds the new Item');
    assert.deepEqual([recorded.kind, recorded.stage, recorded.parent], ['ticket', 'implementing', CONTRACT_TREE.story]);
    assert.match(recorded.description ?? '', /Oldest first in each column/);
  });

  test(named('a change made in the Tracker outside Kiln shows on the board'), options, async (t) => {
    const kiln = await startTestKiln(t);
    const project = await backend.setUp(t, kiln);
    const ticket = byTitle(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`), CONTRACT_TREE.ready);
    const events = await kiln.events();

    await backend.renameOutside(CONTRACT_TREE.ready, 'Draw the run-state columns');
    let updated: ItemUpdatedEvent;
    do updated = await events.next<ItemUpdatedEvent>('item.updated', { timeoutMs: 30_000 });
    while (updated.payload.item.id !== ticket.id || updated.payload.item.title !== 'Draw the run-state columns');
    assert.equal(updated.payload.item.stage, 'implementing');
  });
}
