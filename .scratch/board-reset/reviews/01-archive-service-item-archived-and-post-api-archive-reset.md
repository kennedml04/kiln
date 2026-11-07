# Review: 01 Archive service, Item.archived and POST /api/archive/reset

Branch `kiln/ticket/board-reset/01`, now on merge base 357d0ce. Earlier passes reviewed 2b99804 on 6efd944.

**Verdict: approve.** See the third pass below. The earlier passes are kept for the record.

## Third pass (2026-11-06, after the second rebase)

**Verdict: approve.** The branch has no code left of its own. `git diff master...HEAD` touches only this review file. Master already has Tickets 01–04, and its code is a superset of this Ticket. So merging this branch adds only the review record.

Checked on master's code (merge base 357d0ce):

- `db.ts` has `archive_batches` and `archived_items`. Batches also store `actor_name`, so history can show who pressed Reset.
- `work/archive.ts` `reset()`: an unknown Project is a 404. It takes shipped Items that have no archived row, and none is a 409 "Nothing in Shipped". It writes one transaction, then calls `work.setArchived` for each Item, which publishes `item.updated`. Then it publishes `archive.reset {batchId, projectId?, count}` and returns `{batchId, count, itemIds}`.
- `Item.archived` is filled from `marks.archived` in `toItems` and seeded from the table at start. That replaces this branch's earlier "created before Work, bound after" wiring with something simpler: the service is created after Work and loads the marks quietly.
- `access.ts` has the Member rule `archive.reset`. `archive-routes.ts` sets the target (`project:<id>` or `all`) and the detail `{batchId, count}`.
- `GLOSSARY.md` has **Archived** and **Shipped history**.
- `packages/core/test/archive.test.ts`: 6/6 pass here. `npm run check` is clean. I did not re-run the full suite; the implementer's run on this base was 540 pass, 0 fail.

Test gaps from the Ticket's list are still open on master. None of them blocks a merge:

1. The scope tests use one Project, so a Home Reset over two Projects isn't tested. The spec asks for two.
2. Nothing checks that Asks are untouched, or that an empty unshipped Epic stays unarchived. Gamma is unshipped but has no children.
3. Nothing checks that a 409 is audited as `failed` and writes no batch. `GET /api/archive` now exists, so this is cheap to add.
4. Nothing counts one `item.updated` per archived Item. The test only waits for `archive.reset`.

These belong in a follow-up test Ticket on master, not on this branch.

## Second pass (after the first rebase)

- `git diff master...HEAD` now touches only the Ticket's files: GLOSSARY, access.ts, db.ts, server.ts, archive.ts, archive-routes.ts, work.ts, archive.test.ts and widget-sdk work.ts. The out-of-scope timing changes from the first pass are gone from the branch. Master already has `--test-timeout=300000`, and story-flow uses master's own 90s wait. Finding 5 below is closed.
- db.ts: the archive migration comes after master's sessions migration (`pause_reason` and the resume counts). Order is right, and no migration index moved.
- I re-ran `packages/core/test/archive.test.ts` (5/5 pass), `tsc -b` (clean) and `npm run check` (clean). The implementer's full run after the rebase was 543 tests: 530 pass, 0 fail, 13 skipped (opt-in).
- Master has the issue files for Tickets 02–04 but none of their code: no `archive.ts` or unarchive routes. So this branch still has to merge first, and Tickets 02–04 build on it.

## Checked against the Ticket

| Ticket asks | Where | OK |
|---|---|---|
| `archive_batches`, `archived_items` migration | `packages/core/src/db.ts`. The columns match the spec. | yes |
| `archive.ts` with `reset()` | `packages/core/src/work/archive.ts`. It takes Items in scope that are shipped and not yet archived. Unknown Project is a 404, and none in scope is a 409 "Nothing in Shipped". It writes in one transaction and returns `{batchId, count, itemIds}`. | yes |
| `Item.archived {at, batchId}` in the SDK, filled in by Work | `widget-sdk/src/work.ts`, plus `toItems` and the new `remarkArchived`. `remark` and `setRun` spread the old Item, so the mark survives them. | yes |
| `POST /api/archive/reset {projectId?}` | `archive-routes.ts`, wired in `server.ts` before `handleWorkRoute` | yes |
| Member-only in `access.ts` | A rule with action `archive.reset` | yes |
| Audited as `archive.reset` | `access.note` sets target `project:<id>` or `all`, and detail `{batchId, count}`. The access path records a 409 as `failed`. | yes |
| `item.updated` per Item, then `archive.reset` | `remarkArchived` runs for each id, then `bus.publish('archive.reset', …)` | yes |
| Repo and Tracker untouched | `reset` writes only to SQLite, and the test checks HEAD and a clean tree | yes |
| Glossary: Archived, Shipped history | `GLOSSARY.md`, worded as in the spec | yes |
| Tests: scope, repo untouched, empty, roles, audit, events | `packages/core/test/archive.test.ts` | yes |

The scope test does cover "a shipped Ticket under a live Story". The Ticket "Live updates" is archived, while its Story "Home board" (Stage `spec`) stays unarchived with `childIds.length === 2`.

## Findings (none blocking)

1. **The scope test doesn't check Asks.** Reset never reads Asks, so the risk is low. Add the check when Ticket 02 extends this file.
2. **Nothing tests that a 409 writes no batch or is audited as `failed`.** "Writes no batch" needs `GET /api/archive`, which comes in Ticket 02.
3. **The events test waits for only the first `item.updated`.** A Home Reset over two Projects that counts the `item.updated` events would prove "one per Item".
4. **The SDK has no type for the `archive.reset` event.** Add it in Ticket 02 with `ArchiveBatch`.
5. ~~Out-of-scope test timing changes.~~ Closed by the rebase (see above).
6. **Minor: `reset` throws a plain `Error` before `bind`.** The routes can't reach it, because `bind` runs right after `createWork`. Ticket 02's start-up clearing pass must run after `bind` and after the Projects load.

## Left for later Tickets (as planned)

Ticket 02: Unarchive, `GET /api/archive`, and the clearing rule (`archive.cleared`). Tickets 03 and 04: the Shell.
