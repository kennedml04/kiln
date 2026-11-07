# Review: 02 Unarchive, archive history API and the clearing rule

Round 2, 2026-11-06. Branch `kiln/ticket/board-reset/02` at 2cab997, against the Ticket and `.scratch/board-reset/spec.md`.

Verdict: **changes needed.** The branch carries no implementation of its own any more. Two findings from round 1 are still open in the code it would ship with.

## State of the branch

- The branch's code commit 31c0064 is gone. The rebase onto master (58a1755) dropped it, because master already had the same code through ticket 03's merge (1bc9a98, built on b95c835). `master..HEAD` is now only the round 1 review commit.
- The code for this Ticket is what master holds: `packages/core/src/work/archive.ts`, `archive-routes.ts` and `packages/core/test/archive.test.ts`. They are byte for byte the same as 31c0064.
- `node --test packages/core/test/archive.test.ts`: 6 pass, 0 fail.
- So the "Implementing" round after round 1 changed nothing. Its Digest says the rebase was done, and lists the open points as still open.

## Round 1 findings, re-checked

### 1. Resolved: two lines of work for tickets 01 and 02

Master has one `archive_batches` migration (`db.ts`, the `actor_id`/`actor_name` version). `kiln/ticket/board-reset/01` has no code beyond master, only review commits and a policy file. In practice 01's own implementation was dropped and 02's version shipped through 03. Nothing to merge or reconcile. Whoever closes 01 should say so in its Item.

### 2. Still open: the clearing rule ignores `item.created`

`archive.ts:68-71` checks only `item.updated` and `item.stage_changed`. Work publishes `item.created` when an Item appears (`work.ts:284`, and `work.ts:420` when a Project opens). An archived Item whose file is removed keeps its row, as the spec says. If the file comes back in a Stage that isn't its last, it comes back with `archived` set, and ticket 03's boards hide live work until the next core start. That breaks user story 19 and the spec's rule that a returning Item "comes back archived only while it is still in Shipped".

**Fix:** add `item.created` to the subscriber (`check(payload.item.id)`). Add a test: Reset, `git rm` the Item's file, restore it with an earlier `stage:`, then expect no `archived`, an `item.updated` without it, and an `archive.cleared` audit entry.

### 3. Still open: no roll-up test

The Ticket's test list says "roll-up unaffected". `archiving changes no run state, no file and no commit` only compares run states before and after a Reset. Add the spec's case: a Story with one shipped, archived Ticket and one live Ticket. Ship the live Ticket (fake Agent, or a Tracker edit if the roll-up responds to one). The Story rolls up and ships, and the archived Ticket keeps its mark.

### 4. Still open, optional: clearing through the API

Only the Tracker-edit path of the clearing rule is tested. A short test moving an archived Item back through the API (rework) would cover `item.stage_changed`.

### 5. Still open, minor

- `unarchive` publishes `archive.unarchived` with `itemIds: []` when nothing was put back (`archive.ts:125`). Skip it when `back` is empty.
- Refused or failed Unarchives (400/404) are audited without a `target`. Noting `batch:<id>` or `items` before the call would match Reset.
- `history({ projectId })` hides a Home Reset with no still-archived Items of that Project. That is a fair reading; ticket 04 should know.

## Checked and fine

Unchanged from round 1: the unarchive route (400/404, ignores ids not archived, events, audit), access (Member for writes, Viewer for `GET /api/archive`), history (newest first, still-archived only, gone Items skipped, `q` on title or key, Project filter), the clearing rule on `item.updated` and at core start with `archive.cleared` audited with Kiln as actor, undo by batch, single Unarchive, re-Reset, and repo untouched.

## What the next Implementing round should do

Since master already has this Ticket's code, make the fixes on this branch from master: finding 2 (code and test) and finding 3 (test). Findings 4 and 5 if cheap. Then `npm test`.
