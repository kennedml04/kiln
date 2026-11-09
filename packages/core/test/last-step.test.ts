// run.lastStepAt: set on every step, published to the board at most once per 5 seconds (ticket 01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, ItemUpdatedEvent, Project, StartResult } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { seedScratch } from '@kiln/testing/scratch';

test('a burst of steps gives at most one item.updated per 5s, and the final lastStepAt is the last step', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'progress', text: 'one' },
      { do: 'progress', text: 'two' },
      { do: 'progress', text: 'three' },
      { do: 'progress', text: 'last' },
      { do: 'wait_for_message' },
    ],
  });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const started = Date.now();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);

  const stamps: { at: number; lastStepAt: string }[] = [];
  let deadline = started + 60_000;
  while (Date.now() < deadline) {
    const e = await events.next<ItemUpdatedEvent>('item.updated', { timeoutMs: Math.max(100, deadline - Date.now()) }).catch(() => null);
    const run = e?.payload.item.run;
    if (run?.sessionId === session!.id && run.lastStepAt) {
      if (!stamps.length) deadline = Date.now() + 7_500;
      stamps.push({ at: Date.now(), lastStepAt: run.lastStepAt });
    }
  }
  assert.ok(stamps.length >= 2, 'first step publishes at once, a trailing publish follows');
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]!.at - stamps[i - 1]!.at >= 4_500, 'at most one per 5s');
  const final = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === ticket.id)!;
  assert.equal(final.run?.lastStepAt, stamps.at(-1)!.lastStepAt);
  assert.ok(stamps.at(-1)!.lastStepAt > stamps[0]!.lastStepAt);
});
