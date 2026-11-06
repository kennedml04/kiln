# Spec: A "Reset board" button that clears shipped work off the board

Status: ready-for-agent

Sources: `.scratch/board-reset/story.md`, `.scratch/board-reset/grill.md` (the grill decisions of 2026-11-05, numbered 1–7 below as they are there), and the code as of branch `kiln/story/board-reset` (aabc522). The board views are `packages/shell/src/work/HomeBoard.tsx` (Home, grouped by run state) and `packages/shell/src/work/ProjectView.tsx` (a Project's board, grouped by Stage). Run state is computed in `packages/core/src/work/work.ts` (`runStateOf`: an Item is `shipped` once it is in its kind's last Stage).

## Problem Statement

- After a long run the board holds dozens of shipped Items beside the live work (58 shipped against 13 Stories in backlog on the Kiln Project). Finding what is moving takes scrolling, on desktop and worse on a phone.
- Nothing ever leaves Shipped. Home's "Shipped recently" column and each Project's last-Stage columns only grow.
- The person wants the finished work out of sight in one press, without losing it: shipped Items stay in git and `.scratch`, and can be found again.

## Solution

A **Reset board** entry in a ⋯ menu at the top of each board puts an **archived** mark on every Item that is in Shipped at that moment: Epics, Stories and Tickets. Board views hide archived Items. The mark lives only in Kiln's SQLite, keyed by Item id; Reset never writes to the repo or the Tracker.

There is no confirm step. A toast says "Archived N shipped Items. Undo", and Undo puts back exactly that batch. A new **Shipped history** page lists archived Items grouped by Reset, with a title search, Unarchive for each Item and Unarchive batch for each Reset. Every press, and every Unarchive, is written to the audit log.

On a Project's board Reset covers that Project. On Home it covers every Project. Admins and Members may press it; Viewers can open Shipped history but not change it.

This Story absorbs "A cut-off for Shipped recently" (decision 6): Reset is the only rule that hides shipped Items. There is no age-based cut-off.

## User Stories

### Reset

1. As a Member, a ⋯ menu at the top of Home holds **Reset board**. Pressing it archives every shipped Item in every Project, and the board's Shipped column empties at once.
2. As a Member, the same ⋯ menu at the top of a Project's board holds **Reset board**, which archives only that Project's shipped Items. The last-Stage column of each kind row empties.
3. As a Member, Reset archives shipped Epics, Stories and Tickets alike, including shipped Tickets under a Story that is still live. That Story's card keeps its Ticket count.
4. As a Member, Reset leaves everything not in Shipped alone: live Items, unshipped Epics (empty ones too), Sessions and Asks.
5. As a Member, when nothing is in Shipped in the board's scope, Reset board is shown but disabled, with "Nothing in Shipped".
6. As a Member, Reset never changes a file, a branch or a commit in any Project, and never writes to a Tracker (markdown, GitHub Issues, Jira or any other).
7. As an Admin, every Reset is in the audit log: who, the scope (a Project or all), how many Items and the batch id.
8. As a Viewer, I don't see Reset board, and the API refuses it.

### Undo

9. As a Member, right after a Reset a toast says "Archived N shipped Items." with an **Undo** button. Undo puts back exactly the Items that press archived, and they reappear in Shipped.
10. As a Member, the toast stays for 10 seconds or until I dismiss it or press Undo. Moving to another page doesn't hide it early.
11. As a Member, after the toast is gone I can still undo that Reset from Shipped history with **Unarchive batch**.

### Shipped history

12. As a Member, the ⋯ menu on Home links to **Shipped history** for every Project, and on a Project's board to that Project's Shipped history.
13. As a Member, Shipped history lists Resets newest first. Each shows when, who, the scope and its Items, with Unarchive batch. Each Item shows its Project, kind, title and key, links to its Item page, and has Unarchive.
14. As a Member, the all-Projects history has a Project filter, and a search box that filters Items by title or key. Resets with no matching Item are hidden while a search is on.
15. As a Member, Unarchive puts one Item back in Shipped on the board. Unarchive batch puts back every Item of that Reset that is still archived.
16. As a Member, an archived Item's page still opens, and shows "Archived" with the Reset it belongs to and an Unarchive button.
17. As a Viewer, I can read Shipped history but have no Unarchive buttons, and the API refuses them.

### Staying out of the way

18. As a Member, an Item that ships after a Reset shows in Shipped as usual until the next Reset.
19. As a Member, if an archived Item ever leaves Shipped (it is reopened, or a Ticket under it goes back to work so it no longer rolls up), its archived mark is cleared and it shows on the board where it now is. Live work is never hidden.
20. As the owner, archiving changes nothing about Exits, roll-ups or the Scheduler.
21. As the owner, if Kiln's database is lost, archived Items simply reappear in Shipped. No work is lost.

### Phone

22. As a Member on my phone, the ⋯ menu sits at the top of the board, beside the board's title, with a full-size tap target. Reset board is one entry in it, never a button on its own, so a stray tap can't fire it.
23. As a Member on my phone, the Undo toast shows above the bottom edge, full width, with a full-size Undo button.

## Implementation Decisions

### The archive record (decisions 1, 2 and 5)

- A migration in `packages/core/src/db.ts` adds two tables:
  - `archive_batches`: `id`, `actor` (user id), `at`, `project_id` (null for a Home Reset), `count`.
  - `archived_items`: `item_id` (primary key), `batch_id`, `archived_at`.
- An Item has at most one archived row. The rows of a batch are the Items of that Reset still archived. The batch row keeps its original `count` for the history page ("12 Items, 3 still archived").
- Unarchiving deletes the Item's row. The batch row is never deleted, so history and audit agree.
- Rows whose Item no longer exists in its Tracker are kept, and are skipped by every view. If the Item comes back, it comes back archived only while it is still in Shipped (see the clearing rule).
- This is runtime data, per ADR 0005: Items stay in the Tracker, the mark is a Kiln view preference.

### The archive service

- A new `packages/core/src/work/archive.ts` owns the tables and is created beside Work in the core's wiring. It exposes:
  - `reset({ actor, projectId? })`: collects every Item with `runState === 'shipped'` and no archived row, in the Project or in every Project. If there are none, it throws `WorkError(409, 'Nothing in Shipped')`. Otherwise it writes one batch and its rows in one transaction, and returns `{ batchId, count, itemIds }`.
  - `unarchive({ actor, itemIds?, batchId? })`: deletes the rows named (or the batch's remaining rows). Returns the Item ids put back. Item ids not archived are ignored.
  - `history({ projectId?, q? })`: the batches, newest first, each with its still-archived Items that exist. The `q` filter matches the Item's title or key, case-insensitive.
  - `archivedOf(itemId)`: `{ at, batchId } | undefined`, used by Work.
- **Item field.** `Item` in `packages/widget-sdk/src/work.ts` gains `archived?: { at: string; batchId: string }`. Work fills it when it builds Items (`toItems`) and on every remark, from `archivedOf`. Run state is unchanged: an archived Item is still `shipped`.
- **Events.** Reset and Unarchive publish `item.updated` for each changed Item (with `archived` set or cleared), so the Shell's store and every open board update with no new event handling. They also publish one `archive.reset { batchId, projectId?, count }` or `archive.unarchived { batchId?, itemIds }` for the toast and the history page.
- **The clearing rule.** The service subscribes to `item.updated` and `item.stage_changed`. When an archived Item's `runState` is anything but `shipped`, it deletes the row and publishes `item.updated` with `archived` cleared. At core start, after the Projects load, it runs the same check over every archived row. The clearing is recorded in the audit log with Kiln as actor (`archive.cleared`, the Item and why), so history never loses an Item silently.
- **No effect elsewhere** (implied behaviour). The Scheduler, roll-ups (`packages/core/src/flow/roll-up.ts`), Exits, Asks and Sessions never read `archived`. Roll-ups keep looking at `runState`, so a Story with archived Tickets still ships when they all have.

### Scope and roles (decision 4)

- A Home Reset covers every registered Project. Kiln's roles are install-wide today, so every Project is one the person can see. If per-Project visibility arrives later, Home Reset must cover only the Projects the caller can see, and that Story should change `reset` accordingly.
- Access rules in `packages/core/src/access.ts`: `POST /api/archive/reset` and `POST /api/archive/unarchive` need Member, with actions `archive.reset` and `archive.unarchive`. `GET /api/archive` needs Viewer (the default).
- **Audit.** Each Reset records `action: 'archive.reset'`, the actor, target `project:<id>` or `all`, outcome, and `detail: { batchId, count }`. Each Unarchive records `archive.unarchive` with `detail: { batchId?, itemIds, count }`. A refused or empty Reset (409) is recorded as refused or failed, as other routes do.

### Core API

- `POST /api/archive/reset { projectId? }` → `{ batchId, count, itemIds }`. 404 for an unknown Project, 409 "Nothing in Shipped".
- `POST /api/archive/unarchive { batchId } | { itemIds }` → `{ itemIds }` (those put back). 400 if neither or both are given, 404 for an unknown batch.
- `GET /api/archive?projectId=&q=` → `{ batches: ArchiveBatch[] }`.
- The SDK types go in `packages/widget-sdk/src/work.ts`: `ArchiveBatch { id, actor: { id, name }, at, projectId?, count, items: Item[] }`, and the request and response types above.

### Shell: the board menu (decision 7)

- A small `BoardMenu` component (`packages/shell/src/work/BoardMenu.tsx`): a ⋯ button (`aria-label="Board menu"`) that opens a menu with **Reset board** and **Shipped history**. Reset board is hidden for Viewers, and disabled with "Nothing in Shipped" when no unarchived shipped Item is in scope (computed from the store's Items).
- **Placement.** On Home, a toolbar row at the top of the page, above the Panels and Projects list, with the title "Board" and the menu at its right. On a Project's board, beside the Project's `<h2>` name. The same place on desktop and on the phone layout; the button is at least 44px square. Reset is never in a column header.
- **Hiding.** `HomeBoard` and `ProjectView` drop Items with `archived` set before grouping. Column counts count only what is shown. `ItemCard`'s child count is unchanged, since it reads `childIds`.
- **The Undo toast.** A small toast area in the Shell (none exists yet), `role="status"`, bottom right on desktop and full width above the bottom edge on the phone. After a Reset it shows "Archived N shipped Items." with Undo and a dismiss ×, for 10 seconds or until dismissed. It lives above the router, so navigating doesn't remove it. Undo calls `POST /api/archive/unarchive { batchId }` and replaces the text with "Put back N Items." for 3 seconds. If Reset fails, the toast shows the error instead.

### Shell: Shipped history (decision 1 and the open placement question)

- **Routes.** `/shipped` for every Project and `/projects/:id/shipped` for one, added to `Page` in `packages/shell/src/App.tsx` beside the existing Project routes. The router is path-only, so the Project is in the path, not a query.
- **Page.** A title ("Shipped history", or "Shipped history: <Project>"), a search box (title or key), and on `/shipped` a Project filter (All, then each Project). Then one section per Reset, newest first: "<when>, <who>, <Project or All Projects>: N Items (M still archived)" with **Unarchive batch**, and its Items below, each with its Project (on `/shipped`), kind, title, key, a link to its Item page and **Unarchive**. Unarchive buttons are hidden for Viewers.
- The page fetches `GET /api/archive` and refetches on `archive.*` and `item.updated` events for archived Items. Search is debounced and sent as `q`.
- Batches with no still-archived Items stay listed, as "0 still archived" with no Unarchive batch, so the record of each Reset is there.
- **Item page.** `ItemView` shows an "Archived <when>" badge and an Unarchive button when `item.archived` is set.
- New views follow the existing dark-first theme.

## Testing Decisions

All tests drive Kiln from outside with `startTestKiln(t)` (and the fake Agent where an Item needs to ship), checking API responses, SSE events, the audit log, files and git state.

- **Reset scope:** two Projects, each with shipped and live Items. A Project Reset archives only that Project's shipped Items; a Home Reset archives the rest; live Items, an empty unshipped Epic and open Asks are untouched. A shipped Ticket under a live Story is archived and the Story's `childIds` is unchanged.
- **Repo untouched:** after a Reset and an Unarchive, each Project's working tree is clean and `HEAD` hasn't moved.
- **Empty:** Reset with nothing in Shipped returns 409 and writes no batch.
- **Undo and Unarchive:** unarchiving by batch puts back exactly that batch's Items; a second Reset's Items stay archived. Unarchiving one Item puts back only it, and the batch then reports one fewer still archived. Re-pressing Reset archives an unarchived, still-shipped Item into a new batch.
- **Clearing rule:** an archived Item moved out of its last Stage (rework through the API, or a Tracker edit in the temp repo) loses its mark and an `item.updated` goes out without `archived`; the audit log has `archive.cleared`. A core restart over a Tracker edit made while it was down clears it too.
- **No effect on flow:** a Story whose shipped Tickets are archived still rolls up and ships when its last Ticket ships.
- **History:** `GET /api/archive` lists batches newest first, filters by Project and by `q` on title and key, and skips Items no longer in the Tracker.
- **Roles and audit:** a Viewer gets 403 on reset and unarchive and 200 on `GET /api/archive`. Each Reset and Unarchive has one audit entry with the actor, scope, count and batch id.
- **Events:** a Reset publishes one `item.updated` per archived Item and one `archive.reset`.
- **Shell (Playwright):** on Home and a Project's board, at desktop and phone width: the ⋯ menu shows Reset board, pressing it empties Shipped and shows the toast, Undo brings the cards back. Reset board is disabled with nothing in Shipped and absent for a Viewer. Shipped history lists the Reset, search narrows it, Unarchive and Unarchive batch put cards back on the board. An archived Item's page shows the badge.

## Out of Scope

- An age-based cut-off, or an automatic archive Setting. The grill left an opt-in auto-archive as a possible later Story if the button isn't enough.
- Moving or editing files under `.scratch`, writing frontmatter, or committing anything.
- Archiving Sessions, Asks, or Items that are not in Shipped.
- A confirm dialog.
- Per-Project visibility for Home Reset (roles are install-wide today).
- Showing ship time on cards or sorting Shipped by it; that is "List Shipped recently newest first" (`.scratch/shipped-newest-first/story.md`). History sorts by Reset time, which Kiln knows; it has no reliable ship time to sort Items by.

## Further Notes

- **The cut-off Story.** `.scratch/shipped-recently-cutoff/story.md` is covered by this Story (decision 6) and should be closed as such, in its own file and Item, by whoever owns that branch or by the person. This spec doesn't edit it.
- **Glossary.** The first Ticket adds to `GLOSSARY.md`:
  - **Archived**: an Item hidden from the boards by a Reset board, kept in Kiln's database only; it is still shipped and still in its Tracker. _Avoid_: deleted, closed.
  - **Shipped history**: the page that lists archived Items by Reset, where they can be unarchived.
- **Suggested ticket order:**
  1. The archive tables and service, `Item.archived`, `POST /api/archive/reset`, access rules and audit. Glossary terms.
  2. `POST /api/archive/unarchive`, `GET /api/archive`, and the clearing rule (events and core start).
  3. Shell: `BoardMenu` on both boards, hiding archived Items, the toast with Undo, desktop and phone.
  4. Shell: the Shipped history pages and the Item page's Archived badge.
