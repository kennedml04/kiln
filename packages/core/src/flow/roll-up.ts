// Roll-up: an Item in a `rollUp` Stage (a Story's Tickets, an Epic's Roadmap) waits for its
// children, then ships once every one of them has. When a roll-up Stage's Gate merges (a Story's
// Ticket list), its children start by themselves. A shipped child checks its parent, so a Ticket
// shipping can ship its Story, and that Story its Epic.
import type { Item, ItemMergedEvent, ItemStageChangedEvent, Stage } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import type { Work } from '../work/work.ts';
import type { Scheduler } from './scheduler.ts';

export interface RollUpDeps {
  bus: EventBus;
  work: Work;
  scheduler: Scheduler;
}

export function createRollUp({ bus, work, scheduler }: RollUpDeps): void {
  const stageOf = (item: Item): Stage | undefined =>
    work.project(item.projectId)?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === item.stage);

  const failed = (item: Item, err: unknown) =>
    bus.publish('rollup.failed', { itemId: item.id, projectId: item.projectId, error: err instanceof Error ? err.message : String(err) });

  /** Ships the Item if its Stage rolls up, nothing holds it there, and every one of its children has shipped. */
  const check = async (itemId: string) => {
    const item = work.item(itemId);
    if (!item || item.maintenance || !stageOf(item)?.rollUp || item.runState !== 'backlog' || item.childIds.length === 0) return;
    const children = item.childIds.map((id) => work.item(id));
    if (!children.every((child) => child?.runState === 'shipped')) return;
    await work.advance(itemId).catch((err: unknown) => failed(item, err));
  };

  /** Starts (or queues) each child whose Stage runs a Session and that is not already on its way. */
  const startChildren = async (item: Item) => {
    for (const childId of item.childIds) {
      const child = work.item(childId);
      if (!child || child.runState !== 'backlog' || !stageOf(child)?.role) continue;
      await scheduler.enqueue(childId).catch((err: unknown) => failed(child, err));
    }
  };

  bus.subscribe((event) => {
    if (event.type === 'item.merged') {
      const { itemId, stage } = (event as ItemMergedEvent).payload;
      const item = work.item(itemId);
      if (!item || item.maintenance || item.stage !== stage || !stageOf(item)?.rollUp) return;
      void startChildren(item).then(() => check(itemId));
    } else if (event.type === 'item.stage_changed') {
      const child = work.item((event as ItemStageChangedEvent).payload.itemId);
      if (child?.runState === 'shipped' && child.parentId) void check(child.parentId);
    }
  });
}
