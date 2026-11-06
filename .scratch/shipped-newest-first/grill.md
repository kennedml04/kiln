# Grill: List Shipped recently newest first

Story: `.scratch/shipped-newest-first/story.md`. Grilled 2026-11-05/06 with the person through Kiln Asks, one question at a time.

## What the code has today

- Home (`packages/shell/src/work/HomeBoard.tsx`) groups Items by run state. Only Up next is sorted (by the Scheduler queue). Shipped recently is in store order.
- A Project's board (`packages/shell/src/work/ProjectView.tsx`) has one row of Stage columns per kind. Its last-Stage columns are unsorted too.
- No ship time is stored on an Item. Every bus event is persisted in the `events` table (`type`, `at`, `payload`), including `item.stage_changed { itemId, projectId, from, to }`, which Work publishes after the Tracker writes the new Stage (`packages/core/src/work/work.ts`). `events.withPayload('itemId', id)` already reads an Item's events.
- Tickets merge into the trunk at their Review gate (`Kiln: merge …`) and then move to Shipped seconds later. Stories and Epics ship by roll-up, with no merge of their own.

## Decisions

1. **Ship time is the time Kiln moved the Item into its kind's last Stage**, the `at` of its latest `item.stage_changed` whose `to` is that Stage, from the event log. If an Item was reworked and shipped again, the latest entry counts. It is not the merge commit time: Stories and Epics have no merge, and other Trackers have no git history.
2. **Items with no such record go at the bottom**, in today's order, with no age shown. That covers Items moved into Shipped by hand in the Tracker, and Items shipped before the event log existed. Kiln doesn't search the Tracker's git history for a time.
3. **Every card stands on its own**, sorted by its own ship time, newest at the top. Tickets are not grouped under their Story. A Story ships when its last Ticket does, so it lands right above its Tickets anyway, and its card already shows its Ticket count.
4. **A shipped card shows its age**: a short relative time ("2h ago", "3d ago"), with the exact date and time on hover (and long-press on the phone, for example as the element's `title`). It shows only on shipped cards with a known ship time.
5. **Both boards**: Home's Shipped recently column and every last-Stage column on each Project's board. All other columns keep their order.

## Settled without an Ask

- **Relation to the other Stories.** "A cut-off for Shipped recently" is absorbed by Reset board (board-reset grill, decision 6). Reset board is specced and is not changed by this Story: archived Items stay hidden and this Story only orders what is shown. With newest first, cards that Reset removes are the old ones at the bottom.
- **Where the time comes from.** The core works it out, not the Shell: `Item` (in `packages/widget-sdk/src/work.ts`) gains `shippedAt?: string`, filled by Work when it builds Items and on each Stage change, from the event log. Undefined when the Item isn't shipped or has no record. The Shell sorts by it and formats the age, so the store and every board update through the existing `item.updated` and `item.stage_changed` events.
- **The age stays fresh**: the relative label updates while the board is open (once a minute is enough).
- **Ties** (same time) keep the current order, so the sort is stable.

## Open

- Nothing blocking. Exact wording of the age ("just now" under a minute, when to switch to a date for very old Items) is left to the spec.
