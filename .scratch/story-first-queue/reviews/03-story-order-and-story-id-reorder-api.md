# Review: 03 Story order and Story-id reorder API

## Second review (commit `30c064c`, after the rebase onto master)

The full `npm test` passes: check, Shell build and typecheck are clean; 569 tests, 556 pass, 0 fail, 13 skipped. Commit `30c064c` removes the duplicate `maintenance` fields in `widget-sdk/src/work.ts`, so typecheck passes again. That fix is outside this Ticket but needed, and it is fine to land here.

The rework was only a rebase. None of the first review's findings were addressed. The source diff is the same as at `dfa0169`.

Verdict: **changes needed.** Finding 1 below (first review's finding 1) still breaks the upgrade on the live box.

### Still open from the first review

1. **Must fix: the migration seeds Ticket ids.** Still at `scheduler.ts` (the `if (!selectStoryOrder.get())` block). `createScheduler` runs at `server.ts:213`, and Work's `open` (`work.ts:387`) still awaits `refresh` asynchronously, so `work.item()` is empty when the seed runs. The details and the fix are the same as below.
2. **Should fix: the seed runs whenever `story_order` is empty, not once.** Unchanged.
3. **Should fix: rows for parentless non-Story Items are never removed.** This is now smaller. Master's `work.ts` (`toItems`, lines 215-216) puts a Story-less Ticket under the Maintenance Story, so Tickets no longer get rows of their own once they load. Custom-Workflow kinds still do, and so do the Ticket ids the broken migration seeds. Also, the `storyKeyOf` comment ("until Maintenance Stories exist") is now stale.
4. **Note:** the header comment at `scheduler.ts:2` still says the queue is "ordered by Item priority, then by age".
5. **Tests:** still no tests for the migration, or for a Story leaving the order on ship, `item.removed` or `project.removed`.

### New in this round

- No new defects in the rebase. The master tables (`maintenance_stories`, `story_limits`) come first in `MIGRATIONS` and `story_order` comes after them, so the migration indexes of existing installs are kept. `setStoryLimit` and the story-limits route sit beside the new `reorder(order, projectId?)`.

---

## First review (commit `dfa0169`)

`npm run check` is clean, and `packages/core/test/scheduler.test.ts` plus `project-thread.test.ts` pass (11 of 11). I did not re-run the full suite.

Verdict: **changes needed.** The finding below breaks the migration on the live box, where the agents pool is 0 and Up next is full of Tickets right now.

## Must fix

### 1. The first-start migration seeds Ticket ids, not Story ids (`packages/core/src/flow/scheduler.ts:171-175`)

`createScheduler` runs in `server.ts:213`, right after `createWork`. `createWork` opens each Project's Tracker asynchronously (`open` → `await refresh(entry)`), so `work.item(...)` is still empty when the seeding loop runs. `storyKeyOf` falls back to `itemId`, which puts every queued **Ticket** id into `story_order`.

Once the Items load:
- `queue()` ranks each migrated Ticket by `storyKeyOf(ticket)`, which is now its parent Story. That Story is not in `story_order`, so every migrated entry ranks `Number.MAX_VALUE`. The upgraded order is then just queue age, not "today's start order".
- `PUT /api/scheduler/queue` with any of those Story ids gives 409 "is not waiting in Up next". The Ticket-id shim gives 409 too, because it maps to the Story. Nothing already in Up next can be reordered until some new entry of the same Story queues.
- The table is no longer empty, so the seed never runs again. The Ticket-id rows stay forever.

Fix: seed once the Projects have loaded (await Work's opening, or seed lazily on the first `queue()` / `reorder` after load), and mark the migration as done instead of testing "table is empty". Add a test: start a core with queued Tickets of two Stories, set a reordered `priority` the old way (or seed the queue before the upgrade), restart, and assert that `GET /api/scheduler` keeps that order and that reordering by Story id works.

## Should fix

### 2. "First start" is really "whenever `story_order` is empty" (`scheduler.ts:172`)
The seed runs on any start where the table happens to be empty, for example after every Story has shipped. It is harmless today because `joinOrder` would add the same rows, but it is not what the spec says and it hides finding 1. Record the migration (a `meta` row, or seed inside the `MIGRATIONS` step) instead.

### 3. Rows for parentless non-Story Items are never removed (`scheduler.ts:152-160`, `:283-288`)
A parentless Ticket, or a custom-Workflow kind, is put into `story_order` under its own id. Rows are only deleted when a **Story** ships, when an Item is removed, or when its Project is removed. So that Item's row outlives its queue entry, and `reorder` keeps accepting its id after it has started or shipped. The spec says such entries "follow, in today's priority order", outside the Story order. Ticket 0x (Maintenance) will make parentless Tickets belong to a Story, but custom kinds stay. Either keep non-Story/non-Ticket entries out of `story_order` (rank them after all Stories), or delete the row when its last queue entry leaves. The Digest records this as a decision. It is fine for now if it is written down as a follow-up.

## Notes (no change needed)

- 409 is checked against `story_order` membership only. A Story that has nothing queued (its Grill is done and its Tickets aren't filed yet) can still be reordered. That matches the spec's wording ("a Story in `story_order`") and the Digest says so.
- Shipped Stories are removed on `item.stage_changed`, by checking `runState === 'shipped'`. That relies on Work updating the Item before it publishes the event, which it does.
- The `projectId` variant puts the listed Stories into the sorted positions those same Stories held. That is correct, and the 400 for another Project's Story (and for an unknown `projectId`) is tested.
- Proposals pass their `projectId`, so an accepted reorder can no longer move other Projects' Stories. Good.
- `priority` is still read by the seed and still written as 0 by `insertEntry` (the column is NOT NULL DEFAULT 0, so writing 0 is fine). Nothing orders by it anymore. The header comment at `scheduler.ts:2` still says "ordered by Item priority, then by age". Update it.

## Test coverage against the Ticket

- Spec test 2: covered. A Story id and a Ticket id both move the Story, and the reordered Story's Ticket starts next.
- Spec test 3: covered (`projectId` variant, 400 and 409).
- Not covered: the migration (see 1), and a Story leaving the order when it ships, is removed, or its Project is removed. Add at least one assertion each for ship and `project.removed` through `GET /api/scheduler` / a 409 on a later reorder.
