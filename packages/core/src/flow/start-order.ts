// The order the scheduler tries Up next entries in. Pure, so the rules can be read and tested in one
// place: started Stories (in flight or parked) in Story order, then Stories not started yet; within
// a Story its own entry (Grill, Spec, Tickets Stage Sessions) and then its Tickets by number; entries
// with no Story last, in the order they queued.

/** What the order needs to know about one Story. */
export interface StoryPlace {
  storyId: string;
  /** Its place in the person's Story order (lower is earlier); a Story without one goes last of its group. */
  position: number;
  /** At least one of its Tickets has had a Session: it was in flight and may be parked now. */
  started: boolean;
}

export interface Startable {
  itemId: string;
  /** The Story the entry belongs to: the Story itself for its own entry, the parent for a Ticket. */
  storyId?: string;
}

/** `entries` come in the order they queued; `ticketNumber` gives a Ticket's number within its Story. */
export function startOrder<T extends Startable>(
  entries: T[],
  stories: StoryPlace[],
  ticketNumber: (itemId: string) => number,
): T[] {
  const places = new Map(stories.map((s) => [s.storyId, s]));
  const grouped = new Map<string, { entry: T; i: number }[]>();
  const loose: T[] = [];
  entries.forEach((entry, i) => {
    if (entry.storyId && places.has(entry.storyId)) {
      const list = grouped.get(entry.storyId) ?? [];
      list.push({ entry, i });
      grouped.set(entry.storyId, list);
    } else loose.push(entry);
  });
  const ordered = [...grouped.keys()]
    .map((id) => places.get(id)!)
    .sort((a, b) => Number(b.started) - Number(a.started) || a.position - b.position || a.storyId.localeCompare(b.storyId));
  const result: T[] = [];
  for (const story of ordered) {
    const list = grouped.get(story.storyId)!;
    const own = list.filter((x) => x.entry.itemId === story.storyId);
    const tickets = list
      .filter((x) => x.entry.itemId !== story.storyId)
      .sort((a, b) => ticketNumber(a.entry.itemId) - ticketNumber(b.entry.itemId) || a.i - b.i);
    result.push(...own.map((x) => x.entry), ...tickets.map((x) => x.entry));
  }
  return [...result, ...loose];
}
