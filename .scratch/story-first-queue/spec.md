# Spec: Story-first board

Status: ready-for-agent

Sources: `.scratch/story-first-queue/story.md`, `.scratch/story-first-queue/grill.md` (decisions 1–6 below are numbered as they are there), and the code as of branch `kiln/story/story-first-queue` (c324cad). The scheduler is `packages/core/src/flow/scheduler.ts` behind `packages/core/src/flow/scheduler-routes.ts`; its types are `packages/widget-sdk/src/scheduler.ts`. The markdown Tracker is `packages/core/src/work/markdown-tracker.ts`; Items are made in `packages/core/src/work/work.ts`. The board is `packages/shell/src/work/HomeBoard.tsx`, `ProjectView.tsx`, `ItemCard.tsx` and `packages/shell/src/NeedsYou.tsx`.

## Problem Statement

- Up next is one flat list of Tickets across every Story. Agents take the next Ticket whatever its Story, so six Stories move a little at a time and none ships.
- A Ticket card means nothing without its Story, so the person reads and orders Tickets they never wanted to manage, and still can't see what is close to done.
- `Blocked by` is written in every Ticket file but the scheduler ignores it.

## Solution

The person orders **Stories**. Kiln works out which Ticket starts next from that order.

- Up next on Home and a Project's board list Stories, in the person's order. Only Stories can be dragged or moved with ▲ ▼. Epics stay shelves: they group Stories and have no order of their own.
- Each Project may have at most **N Stories in flight** (default 2). The whole box may have at most as many Stories in flight as the `agents` pool has slots. A Story at the Tickets Stage that is not in flight starts none of its Tickets. Finishing beats starting.
- Within a Story in flight, Tickets start in number order, skipping any whose `Blocked by` Tickets have not shipped. Two unblocked Tickets of one Story may run at once, but one Story never holds every slot of the pool.
- A Story whose only remaining work is the person's move lets go of its slot. When the person answers, it goes ahead of Stories that haven't started.
- Every Ticket appears under its Story: Story cards show "4 of 9 shipped" and the Ticket running or waiting; every Ticket card and Ask names its Story and the Story's why line.
- A Ticket with no Story hangs on the Project's **Maintenance** Story, made by Kiln when the first one appears. That Story never ships and is ordered and limited like any other.

## Terms

- **Story order**: one stored list of Story ids across all Projects. Home shows all of it; a Project's board shows that Project's part.
- **In flight**: a Story at the Tickets Stage that holds a Story slot. It takes one when its first Ticket starts a Session and keeps it until it ships, except while parked.
- **Parked**: a Story that has started but whose every unshipped Ticket is waiting on a person (decision 2). Waiting on a person means: its Session is waiting on a blocking Ask, or it sits at a Gate waiting for a decision (for example Review after the reviewer finished), or its Stage runs no Session and is not Shipped (a "Your move" Stage). A parked Story holds no slot.
- **Started**: a Story at least one of whose Tickets has had a Session (`run` is set). Started Stories, in flight or parked, go before Stories that haven't started when a slot frees.
- **Why line**: the first sentence of the Story's description (the first paragraph of `story.md`), cut to 140 characters with an ellipsis. An empty description gives no why line.

## User Stories

### Ordering Stories

1. As a Member, Up next on Home lists Stories, not Tickets, in the order I set. Each card is a Story card (see 12).
2. As a Member, dragging a Story card, or using its ▲ ▼ (from `up-next-reorder`), moves the Story. Its Tickets move with it. No control moves a single Ticket.
3. As a Member, a Project's board has the same ordered list of that Project's Stories, and moving one there moves it in the shared order among that Project's Stories only. Other Projects' Stories keep their places.
4. As a Member, moving a Story changes which Tickets start next (acceptance 2).
5. As a Member, a new Story, or one that gets work waiting for the first time, joins at the bottom of the order. If I never move anything, it is first in, first out.
6. As a Member, a Story's own Sessions (Grill, Spec, Tickets) also start in Story order within their pool. The in-flight limit does not apply to them.

### Stories in flight

7. As an Admin, Settings lists, beside the pools, a "Stories in flight" number per Project (default 2, a whole number from 0 to 10) and shows the box-wide cap ("at most 2 across all Projects: the agents pool size"). Members and Viewers see these numbers but can't change them.
8. As a Member, with the limit at 2 and three Stories at the Tickets Stage, no Ticket of the third Story starts until one of the first two ships or parks, even when the agents pool has room (acceptance 1). Its waiting Tickets show the hold "Waiting for a Story slot".
9. As a Member, with two Projects each limited to 2 and the agents pool at 2, at most two Stories are in flight across both Projects, taken in Story order.
10. As a Member, lowering a limit or the pool never stops work: Stories already in flight keep their slots; no new Story starts until the count is under the limit.
11. As a Member, when every remaining Ticket of a Story is waiting on me, the next Story in my order may start. When I answer, that Story takes the next free slot before any Story that hasn't started.

### Story cards and Ticket cards

12. As a Member, a Story card shows its title, its Epic, its Stage (Grill, Spec, Tickets, Shipped), "N of M shipped" once it has Tickets, and one sub-row with the Ticket running now, or else the one waiting on me, or else the next one to start (acceptance 4). A Maintenance Story's card reads "N shipped, K open" instead.
13. As a Member, every Ticket card wherever it shows (Running, Needs you, the Ticket's Thread header, a Project's board) shows its Story's title and the Story's why line under its own title (acceptance 3).
14. As a Member, every Ask in Needs you whose Item is a Ticket shows its Story's title and why line; an Ask on a Story shows the Story's why line.
15. As a Member, opening a Story card opens the Story; its Thread lists its Tickets in number order with their Stages, so I can open a single Ticket when it needs me.

### The Home board's columns (decision 6)

16. As a Member, Running shows Story cards for Stories with a Session running now (one of their own or one of their Tickets'), each with the running Ticket as its sub-row (two sub-rows when two Tickets run).
17. As a Member, Needs you shows the Asks themselves, labelled as in 14.
18. As a Member, Up next shows Stories that have work waiting and nothing running, in Story order. Parked Stories with unblocked work waiting show here too, marked "Started".
19. As a Member, Shipped recently shows shipped Stories. A Ticket shows there on its own only when its Story is a Maintenance Story.

### Ticket order within a Story (decision 4)

20. As a Member, a Story's Tickets start in number order. A Ticket whose `Blocked by` lists a Ticket that hasn't shipped waits, shown held "Blocked by 03", and the next unblocked Ticket may start instead.
21. As a Member, two unblocked Tickets of one Story may run at once, but one Story's Tickets never hold more than the pool's size minus one of its slots (and at least one), so a second Story always gets a turn.
22. As a Member, a Story whose remaining Tickets are only blocked by each other keeps its slot. A Ticket blocked by a Ticket of another Story counts as waiting: if that is all the Story has left, it parks like 11, so two Stories can't hold each other up.

### Maintenance (decision 5)

23. As a Member, filing a Ticket with no Story (from the board or `POST /api/projects/:id/items`) files it under the Project's Maintenance Story instead of refusing it. The first time, Kiln makes that Story, titled "Maintenance", at the Tickets Stage, at the bottom of the order.
24. As a Member, a Ticket that comes from the Tracker with no Story (a Widget Tracker's, or a markdown record under `.scratch/items/ticket/` without `parent`) shows and is scheduled under the Maintenance Story (acceptance 5).
25. As a Member, the Maintenance Story never ships, never runs a Session of its own, counts toward the in-flight limit and can be moved in Up next like any other Story.

### The API

26. As a client, `GET /api/scheduler` and the `scheduler.updated` event carry the Story order, each Story's progress and in-flight state, and the limits, so the Shell, the standup Widget and any other client read the same order.
27. As a client, `PUT /api/scheduler/queue {order}` takes Story ids. For one release it also takes Ticket ids: each is mapped to its Story and the Story is moved (decision 3).
28. As an Admin, `PUT /api/scheduler/story-limits/:projectId {limit}` sets a Project's limit.

## Implementation Decisions

### Items: Blocked by and Maintenance

- `Item` (`widget-sdk/src/work.ts`) gains `blockedBy?: string[]` (Item ids) and `maintenance?: true`.
- The markdown Tracker reads `**Blocked by:**` from each Ticket file: `None`, empty or missing gives none; otherwise the numbers (`03`, `3`, `03-slug`, `#3`, comma or space separated) resolve to Tickets of the same Story; `<story>/03` resolves to another Story's Ticket. A number that matches nothing is ignored and reported as a Project file error, like other bad records. `TrackerItem` gains `blockedByKeys`, mapped to Item ids by `work.ts` the same way as `parentKey`.
- Widget Trackers may set `blockedByKeys`; if they don't, no Ticket is blocked.
- The Maintenance Story of a markdown Project is `.scratch/maintenance/story.md` with frontmatter `title: Maintenance`, `stage: tickets`, `maintenance: true`. A Story with `maintenance: true` has `item.maintenance = true`. For a Widget Tracker, Kiln creates a Story titled "Maintenance" through the Tracker and remembers its id in a core table (`maintenance_stories (project_id PRIMARY KEY, story_id)`), since it can't add a field.
- `work.ts` gives every Ticket with no parent the Project's Maintenance Story as `parentId` (and lists it in the Story's `childIds`), creating the Story the first time such a Ticket appears. The Ticket's own record is not rewritten.
- `createItem` for a kind with `parentRequired` and no `parentId`, when the parent kind is `story`, files it under the Maintenance Story (creating it) instead of answering 400. Other `parentRequired` kinds keep the 400.
- The Maintenance Story is exempt from roll-up (its Tickets Stage has `rollUp`; it never moves to Shipped) and the scheduler never admits a Session for its own Stage. Edits that would move it to another Stage are refused with 409 "The Maintenance Story stays open".

### Story order

- New table `story_order (story_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position REAL NOT NULL)`. A Story joins at the bottom (max position + 1) the first time it has a queue entry of its own or of one of its Tickets, or when it is created as Maintenance. A shipped or removed Story leaves the table; a Project's removal (`project.removed`) deletes its rows.
- Migration: on first start, existing queue entries seed the table: each entry's Story (the Item itself if it is a Story, else its parent, else Maintenance), in today's start order, first appearance wins.
- `reorder(order, projectId?)`:
  - Every id must be a Story in `story_order`, or (shim) an Item whose Story is; else 409 `"<id>" is not waiting in Up next`. Shim ids map to their Story; duplicates keep their first place.
  - Without `projectId` the listed Stories take the top positions in the given order, above every unlisted Story, as `reorder` does for Items today.
  - With `projectId` every listed Story must be in that Project (else 400). The listed Stories are put, in the given order, into the positions those same Stories held, so other Projects' Stories don't move.
  - The queue's `priority` column is no longer used for ordering; leave it and stop writing it.
- `ReorderQueueRequest` gains `projectId?: string`; its doc says the ids are Story ids and Ticket ids are accepted until the next release. Proposals (`flow/proposals.ts`) that carry an `order` go through the same `reorder`, so they work unchanged.

### Limits

- New table `story_limits (project_id TEXT PRIMARY KEY, size INTEGER NOT NULL)`; no row means 2. Kept in the core, not in `.kiln/settings.json`, because it sits beside the pools and is a box setting, not a repo one.
- `Scheduler.setStoryLimit(projectId, size)`: 404 for an unknown Project, 400 unless a whole number 0–10; Admin only (a new `scheduler.story_limit` action in `access.ts`, Admin like pool sizes). Raising it dispatches at once.
- The box-wide cap is the size of the pool that the Ticket kind's first Stage uses (`agents` by default), read live; it is not stored. A Project whose Workflow has no `ticket` kind is not limited.

### Dispatch

`dispatchNow` keeps its pools, guards, claims and Stop all. What changes is the order it walks and one extra check for Tickets.

1. Build the start order. Story order is: started Stories (in flight or parked) in Story order, then not-started Stories in Story order. Each Story contributes, in this order, its own queue entry (Grill, Spec, Tickets Stage Sessions) and then its Tickets' queue entries by Ticket key number. Entries with no Story (kinds other than Story and Ticket in a custom Workflow) follow, in today's priority order.
2. For a Ticket entry, before the pool check, the Story must be startable:
   - Any `blockedBy` Ticket not shipped: held "Blocked by NN" (or "Blocked by <story>/NN"). Skip.
   - The Story is in flight: allowed if its Tickets hold fewer than `max(1, poolSize - 1)` slots of the entry's pool.
   - The Story is not in flight: allowed only if its Project has fewer in-flight Stories than its limit and the box has fewer than the cap; else held "Waiting for a Story slot". Starting the Ticket makes the Story in flight.
3. Held reasons from this check are shown on the entry's `held` like a guard's, and are recomputed every dispatch.
4. In-flight and parked are derived from Items, Sessions and open Asks each dispatch, never stored, so a restart needs no state. Dispatch also runs on `ask.created`, `ask.answered`, and `item.stage_changed` of any Ticket, since each can park or unpark a Story or unblock a Ticket.
5. `enqueue`'s start-at-once path (`waitingFirst`) applies the same Story check, so pressing Start on a Ticket of a Story not in flight queues it with the hold rather than jumping the limit. An attended start (a person in the Thread) does not bypass the Story limit; it does bypass guards as today.

### Scheduler state

`SchedulerState` gains:

```ts
/** Stories with work waiting, running or parked, in the start order dispatch uses. */
stories: StoryEntry[];
limits: { perProject: Record<string, number>; boxWide: number };

interface StoryEntry {
  storyId: string;
  projectId: string;
  inFlight: boolean;
  parked: boolean;
  started: boolean;
  maintenance: boolean;
  /** Tickets shipped / all Tickets. */
  shipped: number;
  total: number;
  /** Tickets with a Session running now. */
  running: string[];
  /** Tickets waiting on a person. */
  waiting: string[];
  /** The Ticket that will start next, if any. */
  next?: string;
}
```

`QueueEntry` gains `storyId?: string`. `queue` stays in start order. A small pure function `startOrder(...)` in the core computes both, so its rules can be read and tested in one place through the API.

### Why line

- `storyWhy(description?: string): string | undefined` in `widget-sdk` (first sentence, 140 characters, ellipsis), so the Shell and the standup Widget cut it the same way.

### Shell

- `UpNext` (`HomeBoard.tsx`) renders `scheduler.stories` that are not running, as Story cards, and drag / ▲ ▼ send Story ids. On a Project board the same list, filtered to the Project, sends `projectId`.
- A `StoryCard` (new, beside `ItemCard`) shows the parts in story 12. Ticket cards (`ItemCard` when `item.kind === 'ticket'`) get a Story line: the Story title, then the why line in the muted style, one line each, ellipsised.
- Running groups by Story as in 16; Shipped recently shows Stories, and Tickets only of Maintenance Stories.
- `AskSubject` in `NeedsYou.tsx` adds the Story title and why line for Ticket Asks.
- `SettingsPage.tsx`: a "Stories in flight" block beside the pools: one number input per Project for Admins, read-only text otherwise, and the box-wide cap line.
- Dark theme first, as everywhere in the Shell.

### Standup

- The standup Story (`.scratch/standup/`, not written yet) reads `scheduler.stories` and `storyWhy`. This Story does not build the standup.

## Testing Decisions

Through `startTestKiln` / `openShell` and the fake Agent, asserting on `GET /api/scheduler`, Items from the API, and the page; never on tables. A temp git repo with `.scratch/<story>/story.md` and `issues/NN-*.md` files gives the Stories and Tickets. Core tests in `packages/core/test/scheduler.test.ts` (or a new `story-queue.test.ts`); Shell tests in `packages/shell/test/`.

1. Limit 2, agents pool 3, three Stories at Tickets with unblocked Tickets: two Stories' Tickets start; the third's Tickets are held "Waiting for a Story slot". When every Ticket of one of the first two ships, a Ticket of the third starts (acceptance 1).
2. Moving the third Story to the top of the order before anything starts makes its Tickets start first (acceptance 2). A Ticket id in `PUT /api/scheduler/queue` moves its whole Story.
3. `reorder` with `projectId` moves only that Project's Stories; another Project's Story keeps its position.
4. Two Projects with limit 2 each and the agents pool at 2: at most two Stories in flight in total.
5. `Blocked by`: Ticket 02 blocked by 01 is held "Blocked by 01" while 01 runs and starts after 01 ships; Ticket 03, unblocked, runs beside 01 when the pool has room. With the pool at 2, a Story's Tickets hold at most one slot; with the pool at 3, at most two.
6. Parking: limit 1, Story A's only open Ticket reaches the Review Gate; Story B's Ticket starts. Approving A's Gate with a further Ticket of A waiting: A's Ticket starts before Story C (not started), as soon as a Story slot frees.
7. A Ticket blocked only by another Story's unshipped Ticket parks its Story rather than holding the slot.
8. Maintenance: `POST /api/projects/:id/items {kind: 'ticket'}` without a parent succeeds; the Ticket's `parentId` is a Story with `maintenance: true` titled "Maintenance"; it is scheduled under the limit; it never ships when all its Tickets ship (acceptance 5). A `.scratch/items/ticket/x.md` without `parent` gets the same parent.
9. Limits API: a Member gets 403; 11 and 1.5 get 400; default reads 2; raising it starts held Tickets.
10. Shell: Up next shows Story cards only, with "N of M shipped"; Running shows the Story with its running Ticket's title; a Ticket's Ask in Needs you shows its Story's title and why line (acceptance 3, 4).
11. Shell: Settings shows the per-Project limit and the box-wide cap; an Admin changing it updates `GET /api/scheduler`.
12. Existing `up-next-reorder` tests move Story cards instead of Ticket cards; update them rather than keep Ticket-level assertions.

## Out of Scope

- The standup Widget itself.
- Reordering Tickets within a Story (their order is their number and `Blocked by`).
- Epic order or Epic limits.
- Removing the Ticket-id shim (next release).
- Writing `Blocked by` from the board.
- Limits for Story-stage Sessions (Grill, Spec, Tickets); the pools already limit those.

## Further Notes

- Decision 3 says Story ids "per Project". This spec keeps one order across Projects (Home needs one for the box-wide cap to pick between Projects) and makes a Project-scoped reorder move only that Project's Stories within their own positions. That satisfies both views.
- Decision 1 says the per-Project limit is "set in that Project's Settings" and "beside the pools in Settings". This spec stores it in the core and edits it on the Settings page beside the pools, not in `.kiln/settings.json`, so changing it needs no commit.
- Story 22 (a Ticket blocked by another Story's Ticket parks its Story) is not in the grill; it is chosen so two Stories can't hold each other's slots forever.
- `parked` counts Asks that block the Session. A non-blocking Ask leaves the Story in flight.
- The agents pool was set to 0 on 2026-11-07 so nothing new starts until this Story is ticketed. Set it back to 2 when its Tickets are ready to run. With the pool at 0 the box-wide cap is 0 and no Story is in flight, which is the intended pause.
