// The Story-level view of the board: which Stories have work, how far along they are, and what
// is running or waiting in them. Derived from Items, the queue and the Story order on every call.
import type { Item, QueueEntry, StoryEntry } from '@kiln/widget-sdk';

const ticketNumber = (item: Item) => Number.parseInt(/\d+/.exec(item.key.split('/').pop() ?? '')?.[0] ?? '', 10) || 0;

export function storyEntries(args: {
  items: Item[];
  queue: QueueEntry[];
  /** Story ids in the person's order, with their Project. */
  order: { storyId: string; projectId: string; position: number }[];
}): StoryEntry[] {
  const byId = new Map(args.items.map((i) => [i.id, i]));
  const storyOf = (item: Item) =>
    item.kind === 'story' ? item.id : item.parentId && byId.get(item.parentId)?.kind === 'story' ? item.parentId : undefined;
  const ids = new Map<string, number>(args.order.map((o) => [o.storyId, o.position]));
  // A Story whose Ticket started at once never queued, so it is not in the order yet: it goes last.
  for (const item of args.items) {
    const story = storyOf(item);
    if (story && (item.runState === 'running' || item.runState === 'waiting') && !ids.has(story)) ids.set(story, Number.MAX_VALUE);
  }
  const queued = new Set(args.queue.map((e) => e.itemId));
  const entries: StoryEntry[] = [];
  for (const [storyId] of [...ids].sort((a, b) => a[1] - b[1])) {
    const story = byId.get(storyId);
    if (!story || story.kind !== 'story' || story.runState === 'shipped' || story.archived) continue;
    const tickets = story.childIds
      .map((id) => byId.get(id))
      .filter((i): i is Item => Boolean(i) && i!.kind === 'ticket')
      .sort((a, b) => ticketNumber(a) - ticketNumber(b));
    const open = tickets.filter((t) => t.runState !== 'shipped');
    const running = tickets.filter((t) => t.runState === 'running').map((t) => t.id);
    const waiting = tickets.filter((t) => t.runState === 'waiting').map((t) => t.id);
    const next = tickets.find((t) => queued.has(t.id) || t.runState === 'up-next')?.id;
    const started = tickets.some((t) => t.run) || story.runState === 'running';
    const parked = started && running.length === 0 && open.length > 0 && open.every((t) => t.runState === 'waiting');
    entries.push({
      storyId,
      projectId: story.projectId,
      inFlight: started && !parked,
      parked,
      started,
      maintenance: Boolean(story.maintenance),
      shipped: tickets.length - open.length,
      total: tickets.length,
      running: story.runState === 'running' && !running.length ? [storyId] : running,
      waiting,
      ...(next ? { next } : {}),
    });
  }
  return entries;
}
