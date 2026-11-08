# Review: 05 Scheduler dispatch: Story slots, Blocked by, parking

Branch `kiln/ticket/story-first-queue/05`, commits c974319 and 811fb93, reviewed against 47f3cbe (the merge of 01 and 03).

## Verdict

Mostly done, with one spec question the person should settle (finding 1) and one small bug (finding 2). `startOrder`, the Blocked-by holds, the per-Project and box-wide limits, the pool-share rule, the derived in-flight, parked and started flags, the extra dispatch triggers, the Story check on enqueue's start-at-once path, `SchedulerState.stories` / `limits`, `QueueEntry.storyId` and the limits API all match the Ticket. Tests 1, 4, 5, 6 and 7 of the spec are in `packages/core/test/story-queue.test.ts`, plus test 9 (limits API).

Full `npm test` on this branch: `check`, the Shell build and typecheck passed. The `node --test` run had no failures so far but had not finished when this review was committed. Run it to the end before merging.

## Findings

### 1. A Story that unparks goes over the limit at once, without waiting for a slot (major, needs the person's call)

`scheduler.ts` `storyFacts`: `inFlight = started && !parked && unshipped.length > 0`. When a parked Story unparks (its Gate is approved and a further Ticket can start), it counts as in flight again at once, and `storyHold` lets its Ticket through the `f.inFlight` branch with no limit check.

The spec says the opposite. Story 11: "When I answer, that Story takes **the next free slot** before any Story that hasn't started." Test 6: "A's Ticket starts before Story C (not started), **as soon as a Story slot frees**." Story 10: "no new Story starts until the count is under the limit".

The test (`story-queue.test.ts`, "a Story whose only open Ticket reaches its Gate is parked…") asserts the implemented behaviour, not the spec's. With the limit at 1 and Beta still running, approving Alpha's Gate starts A two straight away, so 2 Stories are in flight under a limit of 1.

The effect grows: with limit 1, every Story can start, park, and let the next one in. When they all unpark, all of them are in flight together. The pool still caps Sessions, but the in-flight limit no longer does. That undercuts "finishing beats starting" and the box-wide cap.

The implementer's Digest records this as a deliberate choice. It is a reasonable reading (a started Story never "needs a new slot"), but the spec's wording and test 6 say otherwise. A fix that still stores nothing: rank the started, unparked Stories by Story order, and count as in flight only those with a Ticket running or waiting, plus the first ones up to the limit. Any others wait for a slot, still ahead of unstarted Stories because `startOrder` puts started Stories first. If the person agrees with the implemented behaviour, update the spec (stories 10 and 11, test 6) instead.

**The person's call (2026-11-08):** follow the spec. A Story that unparks waits for the next free slot, ahead of any Story that hasn't started. Implement the reviewer's fix (rank started, unparked Stories by Story order; count as in flight only those with a Ticket running or waiting plus the first ones up to the limit) and change the parked-Story test to assert that. Do not change the spec.

### 2. `waitsOnPerson` gives a wrong answer on diamond-shaped Blocked-by chains (minor bug)

`scheduler.ts` `waitsOnPerson`: `seen` is shared across sibling branches and never cleared when a branch returns. So a Ticket reached twice through two blockers is treated as a cycle the second time, and `every` fails.

Example, one Story: 01 waits at its Review Gate; 02 is blocked by 01; 03 and 04 are each blocked by 02; 05 is blocked by 03 and 04. Checking 05, the 03 branch visits 02 and adds it to `seen`. The 04 branch then finds 02 in `seen` and returns false. So 05 "waits on nobody" and the Story keeps its slot, although every open Ticket waits on the person. Fix: remove the id from `seen` when its branch returns (track only the current path), or memoise the result per Ticket for the pass.

### 3. Hold reasons shown in one pass ignore slots the same pass would take (minor, display only)

In `queue()`, `claimed` marks a Story as taking a slot as soon as one of its Ticket entries is unheld, even when that entry can't start because its pool is full. Also, a claimed Story's later Tickets are not counted against `max(1, poolSize-1)`. So in `GET /api/scheduler`:

- a Story's third unblocked Ticket can show no hold while the pass would hold it;
- a Story further down can show "Waiting for a Story slot" because of a Ticket that isn't starting.

`dispatchNow` reads the queue again after every start, so what actually starts is right. Only the `held` text can be off until the next dispatch. Acceptable, but worth a comment.

### 4. `dispatchNow` rebuilds the whole queue for every entry (minor, efficiency)

The loop calls `queue()` once per entry it looks at, not only after a start. Each call runs `storyFacts()` over every Item, the `waitsOnPerson` recursion, and a scan of the slots for each held Ticket. `state()` also builds the facts twice (in `queue()` and `storyEntries()`). This is fine at today's sizes. Reading the queue again only after a successful `launch` would keep the fix and drop most of the cost.

### 5. `limits.boxWide` comes from the first Project with a Ticket kind (note)

If Projects' Ticket kinds use different pools, `boxWide` shows only the first one's size, while dispatch applies each Ticket's own Project's cap. The spec reads it as one number, so this is consistent with the spec. It only matters for custom Workflows.

## Checked and fine

- `startOrder` (`flow/start-order.ts`): started Stories first, then Story position, then id; within a Story its own entry first, then Tickets by number; loose entries last in queue order. Pure and readable.
- Blocked by: holds read "Blocked by 01" for the same Story and "Blocked by beta/01" for another Story. They are checked before guards and before the pool check, and worked out again every dispatch.
- Not-in-flight Stories are checked against both the per-Project limit and the box-wide cap (the Ticket kind's first-Stage pool, read live). A Project with no `ticket` kind is not limited.
- Pool share is `max(1, size-1)`, counted from real slots held by the Story's Tickets in that pool.
- Parked follows the spec: a blocking Ask or Gate (`runState === 'waiting'`, which only blocking Asks and Gates set), a Stage with no role, or blocked only by another Story's Ticket. Tickets that only block each other keep the slot. A non-blocking Ask leaves the Story in flight.
- Dispatch runs on `ask.raised` (the spec's "ask.created" doesn't exist), `ask.answered`, and every `item.stage_changed`. `dispatch` is serialised and `enqueue` awaits it.
- `enqueue`: the Story check (Blocked by, then the Story rules) applies to attended starts too; guards are still skipped for attended starts.
- Limits API: Admin-only through `access.ts` (`scheduler.story_limit`); 404 for an unknown Project, 400 unless a whole number 0–10, default 2, and raising the limit dispatches.
- The scheduler-test changes (pool share) and the demo-replay change (02 now waits for 01) follow from the new rules and don't weaken what those tests check.
- The duplicate `maintenance` fields left by the merges were removed from `Item` / `TrackerItem`; one definition of each remains.

## Not covered here (other Tickets)

- Test 2 and test 3 (reorder, Ticket-id shim) are ticket 03's; test 8 (Maintenance) is ticket 02's. No test shows that a Maintenance Story's Tickets count toward the limit, though the code treats that Story like any other.
- Shell use of `scheduler.stories` and `limits` is tickets 06–08.

## Second round (2026-11-08, at e00e65c)

Verdict: **changes requested**. Since the first review, the branch has only merged master twice (d078393, e00e65c). The merge is clean: master's stand-in `flow/story-entries.ts` is replaced by the scheduler's own `storyEntries`, nothing imports the old file, and master's Shell (`upNextStories`, `StoryCard`, Settings) reads the same `StoryEntry` fields. But neither code finding from round one is fixed, including the one the person decided.

### Still open, must fix

- **Finding 1, which the person decided on 2026-11-08 (above), is not implemented.** `scheduler.ts:224` still has `inFlight: started && !parked && unshipped.length > 0`, and `storyHold` (`scheduler.ts:272`) still lets an unparked Story through without a slot check. `story-queue.test.ts:190-193` still asserts that A two starts as soon as the Gate is approved, while Beta holds the only slot under limit 1. Do what the person asked: rank the started, unparked Stories by Story order; count as in flight those with a Ticket running or waiting, plus the next ones up to the limit (and the box-wide cap); any others are held "Waiting for a Story slot", still ahead of unstarted Stories. Then change the test: with Beta running, A two stays held "Waiting for a Story slot" after the approval; once Beta's Ticket ships (or parks), A two starts before Gamma's C one. Leave the spec as it is.
- **Finding 2 is not fixed.** `waitsOnPerson` (`scheduler.ts:201-214`) still shares `seen` across sibling branches. Track only the current path (`seen.delete(ticket.id)` before returning), or memoise per pass. Add the diamond case from finding 2 to the parking test.

### New, minor (from the merge)

- `widget-sdk/src/scheduler.ts:9`: an orphan doc comment, "Stories in flight per Project when none is set.", is left with nothing under it. The constants it described moved to line 34. Delete it.
- `widget-sdk/src/scheduler.ts:52`: `StoryEntry.running` now says "Tickets with a Session running now", but `storyEntries` (`scheduler.ts:326`) puts the Story's own id there when only its own Session runs. That is master's rule, and the Digest says it was kept. Master's doc ("Items with a Session running now (its Tickets, or the Story itself)") was right. Put it back.

### Carried from review 06 (findings 2 and 4 there were left to this Ticket)

- Review 06 finding 2 (a move on Home pushes running Stories down the order): `startOrder` now puts started Stories first, so a running Story's next Ticket still goes ahead of not-started ones whatever their position. This is covered, and it needs no change.
- Review 06 finding 4 (the Shell can send an id `reorder` refuses): `launch` now calls `joinOrder`, so every Story started from now on is in `story_order`. The gap that remains is a Story started before the upgrade that has no queue entry. The migration seeds only from queue rows, so such a Story is missing from the order. It reaches Up next only if it gets a queue entry, and `enqueue` joins it then. I could not find a path that sends a refused id. Closed.

### Still not covered

- No test shows a Maintenance Story's Tickets counting toward the limit (open since round one).
- Findings 3 to 5 stand as written. They are minor and not blocking.

### Tests

See the result line below.
