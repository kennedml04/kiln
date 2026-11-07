# Spec: A cut-off for "Shipped recently"

Status: ready-for-agent

Blocked by: "Shipped newest first" (`.scratch/shipped-newest-first/spec.md`), at least its Ticket 1 (`Item.shippedAt`). Its Ticket 2 (`byShippedNewest`, `useMinuteClock`, `ShippedAge`) is also reused here; build this after it, or pull those pieces forward in this Story's first Shell Ticket.

Sources: `.scratch/shipped-recently-cutoff/story.md`, `.scratch/shipped-recently-cutoff/grill.md` (grill decisions of 2026-11-06, numbered 1–5 below as they are there), and the code as of branch `kiln/story/shipped-recently-cutoff` (73ce6bc). The boards are `packages/shell/src/work/HomeBoard.tsx` (Home, grouped by run state; the `shipped` group is "Shipped recently") and `packages/shell/src/work/ProjectView.tsx` (a Project's board, one row of Stage columns per kind). Shipped history is `packages/shell/src/work/ShippedHistory.tsx` (routes `/shipped` and `/projects/:id/shipped`), fed by `GET /api/archive` (`packages/core/src/work/archive-routes.ts`). Whole-Kiln settings live in the `core_settings` table (`packages/core/src/setup/setup.ts`). The Settings page is `packages/shell/src/work/SettingsPage.tsx`.

## Problem Statement

- The Shipped columns keep every Item that ever shipped, so they grow without end and bury what shipped this week.
- Reset board clears them, but only when someone remembers to press it. Between Resets the column fills up again.
- Shipped history only lists archived Items, so a shipped Item that was never archived can only be found on the board.

## Solution

Each shipped column shows only Items whose **ship time** (`Item.shippedAt`) is inside a window. The window is one whole-Kiln Setting, set by an Admin on the Settings page: 1, 3, 7, 14 or 30 days, or Off. Default 7 days. Items with no ship time are hidden by the cut-off. The cut-off is a view rule only: nothing is archived and nothing is written anywhere.

Each column the cut-off shortens ends with a **"Show all (N older)"** link to Shipped history, which now lists **every** shipped Item, newest first, with archived ones marked. Today's Reset-by-Reset view stays one click away as "Archived only", so Unarchive and Unarchive batch work as now.

The rule is the same for Epics, Stories and Tickets: each Item by its own ship time.

## User Stories

### The cut-off on the boards

1. As a Member, Home's Shipped recently column shows only Items shipped within the window (7 days unless an Admin changed it), newest first.
2. As a Member, on a Project's board, the last-Stage column of each kind row (Tickets, Stories, Epics, or whatever the Workflow has) is cut the same way. Every other column is unchanged.
3. As a Member, Epics, Stories and Tickets follow the same rule, each by its own ship time. A shipped Ticket under a Story that is still live is cut by the Ticket's own time.
4. As a Member, a shipped Item with no ship time (moved into Shipped by hand in the Tracker, or shipped before Kiln kept an event log) is hidden while the cut-off is on.
5. As a Member, a column the cut-off shortens ends with "Show all (N older)", where N is the number of shipped Items the cut-off hides from that column. With nothing hidden there is no link.
6. As a Member, on a Project's board the link opens that Project's Shipped history; on Home it opens Shipped history for every Project.
7. As a Member, a shipped column the cut-off leaves empty says "Nothing shipped in the last N days" (with "day" for 1), and the Show all link below it if anything is hidden.
8. As a Member, a shipped column with no shipped Items at all (nothing ever shipped, or all archived) keeps today's empty state; there is no Show all link.
9. As a Member, an Item drops out of the column when its age passes the window while the board is open, and N goes up by one, with no reload.
10. As a Member, an Item that is reworked and ships again comes back to the top of the column with its new ship time.
11. As a Member, column counts count only the cards shown.
12. As a Member, the cut-off, the link and the empty line are the same on desktop and on the phone.

### The Setting

13. As an Admin, the Settings page has "Shipped recently shows": 1 day, 3 days, 7 days, 14 days, 30 days, or Off. It applies to Home and to every Project's board.
14. As an Admin, choosing Off shows every shipped Item that is not archived, with Items without a ship time at the bottom (today's behaviour plus "Shipped newest first").
15. As a Member or Viewer, I can't change the Setting; the Settings page isn't mine, and the API refuses the change.
16. As a Member, when an Admin changes the Setting, open boards follow it at once.
17. As an Admin, each change is written to the audit log.

### Shipped history

18. As a Member, Shipped history lists every shipped Item, newest first by ship time, with Items without one at the end. Each row shows the Project (on the all-Projects page), kind, title, key and its ship age ("3d ago", exact time on hover), and links to the Item page.
19. As a Member, archived Items in that list carry an "Archived" mark and an Unarchive button.
20. As a Member, an "Archived only" choice shows today's view: Resets newest first, each with its still-archived Items, Unarchive and Unarchive batch.
21. As a Member, the Project filter and the title-or-key search work in both views.
22. As a Member, the ⋯ menu's Shipped history entry opens the same page as before (the all-shipped view).
23. As a Viewer, I can read both views but have no Unarchive buttons.

### Staying out of the way

24. As the owner, Reset board is unchanged. It still archives every shipped Item in scope, including ones the cut-off hides, and "Nothing in Shipped" still means no unarchived shipped Item in scope.
25. As the owner, archived Items stay hidden on the boards whatever the cut-off says.
26. As the owner, the cut-off changes nothing about Exits, roll-ups, the Scheduler or the Tracker.

## Implementation Decisions

### The rule (decisions 2 and 4)

- **Shown.** With a window of D days, a shipped, unarchived Item is shown in its shipped column when it has `shippedAt` and `now - shippedAt < D × 24h`. A `shippedAt` slightly in the future (clock skew) counts as shown.
- **Hidden.** Every other shipped, unarchived Item in that column is hidden by the cut-off, including every Item without `shippedAt`.
- **Off.** Nothing is hidden by the cut-off.
- **Archived first.** Archived Items are dropped before the cut-off and never counted in N.
- **Same for every kind.** One window; each Item is judged alone. No look at parents or children.

### Where the filter runs: the Shell

- The filter runs in the Shell, from the store's Items, `shippedAt` and the Setting. The core sends no cut list. Reasons: the age moves with the clock, the boards already group and sort in the Shell, and N comes from the same list.
- A pure helper beside `byShippedNewest` in `packages/shell/src/work/shipped.ts`:
  `cutShipped(items: Item[], window: ShippedWindow, now: number): { shown: Item[]; hidden: number }`.
  `shown` is sorted with `byShippedNewest`. With `'off'`, `shown` is every Item sorted, and `hidden` is 0.
- `HomeBoard` applies it to the `shipped` group in its `columns` memo. `ProjectView` applies it to the last-Stage column of each kind row only. Both read `now` from `useMinuteClock()` so cards leave on time. The clock must not re-render every card: only the column lists recompute once a minute, and `ItemCard` stays memoised.
- The column component gets the `hidden` count and the window and renders the link and the empty line. The column header count is `shown.length`.

### The Setting (decision 5)

- **Type** in `packages/widget-sdk`: `type ShippedWindow = 1 | 3 | 7 | 14 | 30 | 'off'` and `interface BoardSettings { shippedWindow: ShippedWindow }`. Default `7`.
- **Storage.** One row in `core_settings` with key `board`, JSON `{ "shippedWindow": ... }`. A missing row or an unknown value reads as the default.
- **Routes** (new, beside the setup routes):
  - `GET /api/board-settings`, role Viewer → `BoardSettings`. Not `GET /api/setup`, which is Admin-only, because every board needs it.
  - `PUT /api/board-settings` `{ shippedWindow }`, role Admin, audit action `board_settings.update` with `{ from, to }`. An unknown value is a 400 with "shippedWindow must be 1, 3, 7, 14, 30 or off".
  - Both added to `packages/core/src/access.ts`.
- **Event.** A change publishes `board_settings.updated` with the new `BoardSettings` on the bus, so SSE carries it to every open Shell.
- **Shell store.** The store loads `GET /api/board-settings` at start beside the other initial loads and keeps `boardSettings`. It replaces it on `board_settings.updated`. Until it loads, the boards use the default 7 days.
- **Settings page.** A "Board" section in `SettingsPage.tsx` (Admin-only, like the page) with a select labelled "Shipped recently shows": "1 day", "3 days", "7 days", "14 days", "30 days", "Off (show everything)". It saves on change, shows an error on failure, and follows `board_settings.updated`.

### The link and the empty line (decision 3, open wording)

- **Link text:** "Show all (N older)", for example "Show all (12 older)". Hidden when N is 0. It is an `<a>` with `followLink`, at the bottom of the column, under the last card, quiet text in the dark-first theme, at least 44px tall on the phone.
- **Target:** on a Project's board `shippedPath(projectId)`; on Home `shippedPath()`. Both open the all-shipped view. On Home it is unfiltered (it does not carry Home's other filters).
- **Empty line:** "Nothing shipped in the last N days" (N is the window; "in the last day" for 1). Shown when the cut-off leaves the column empty and at least one Item is hidden. With the Setting Off, or with no shipped Items at all, the column keeps today's empty state.

### Shipped history widened (decision 3, open route and filters)

- **Routes unchanged:** `/shipped` (all Projects) and `/projects/:id/shipped` (one Project). A view choice is added as a query, `?view=archived`; no query means the all-shipped view. `shippedPath(projectId?, view?)` builds both.
- **View choice.** A two-option toggle at the top: "All shipped" and "Archived only", with the choice kept in the URL so the link and the back button work.
- **All shipped** is built in the Shell from the store's Items: every Item with `runState === 'shipped'` in scope (archived or not), sorted with `byShippedNewest`, filtered by the Project select and the search box (title or key, case-insensitive, the same 250ms debounce). The cut-off is not applied here. Each row: Project (all-Projects page only), kind, title linking to the Item page, key, `ShippedAge` (none when there is no ship time), and for archived Items an "Archived" mark and Unarchive (not for Viewers). Empty text: "Nothing has shipped yet." or "No shipped Items match." during a search.
- **Archived only** is today's page, as is: `GET /api/archive`, Resets newest first, Unarchive batch, Unarchive per Item, with its search and Project filter.
- **No new core route** for the all-shipped view: the store already holds every Item, archived ones included. If the store ever stops holding archived Items, a later Story adds a route.
- The ⋯ menu entry keeps its label and target.

### Not changed

- The core's Items, `GET /api/items`, `item.updated`, Reset board, the archive routes, `BoardMenu`'s "Nothing in Shipped" rule, Exits, roll-ups and the Scheduler.
- The Item page.

## Testing Decisions

Core tests drive Kiln from outside with `startTestKiln(t)`; Shell tests use `openShell(t, kiln)`. Items with known ship times come from shipping them through `kiln.installFakeAgent({ script })`. For ages older than the window, the Playwright tests set the browser clock forward (Playwright's clock API) rather than writing to the event log.

- **Setting API:** `GET /api/board-settings` gives 7 days on a fresh core. An Admin's `PUT` of each value round-trips and survives a core restart with the same data folder. A Member's and a Viewer's `PUT` are refused; a Viewer's `GET` works. A bad value is a 400. A change publishes `board_settings.updated` and writes an audit entry.
- **Shell unit tests** (`node --test`, no browser) for `cutShipped`: an Item inside the window is shown; one just past it is hidden; one with no `shippedAt` is hidden; a future `shippedAt` is shown; `'off'` shows all with those without a time last and `hidden` 0; shown Items are newest first.
- **Shell (Playwright),** at desktop and phone width:
  - Home and a Project's board with Items shipped now and the clock moved 8 days on: the old ones leave the Shipped column without a reload, "Show all (N older)" appears with the right N, and other columns are unchanged.
  - A column with every Item hidden shows "Nothing shipped in the last 7 days" and the link.
  - An Item moved into Shipped by a Tracker edit in the temp repo is hidden and counted in N.
  - An Admin sets 1 day on the Settings page; an open board in a second page follows it. Off shows every shipped Item with no link.
  - The link on a Project's board opens that Project's Shipped history in the All shipped view, listing every shipped Item newest first, archived ones marked with Unarchive. "Archived only" shows the Reset batches with Unarchive batch working as before.
  - After a Reset, the archived Items are gone from the board and not counted in N.

## Out of Scope

- Per-person or per-Project windows, or a different window per kind.
- Archiving anything automatically, or any write caused by the cut-off.
- A core route that sends a cut list or the hidden count.
- Paging or virtualising Shipped history.
- Showing ship time on the Item page.
- Any change to columns other than the shipped ones.

## Further Notes

- **Supersedes board-reset decision 6.** `.scratch/board-reset/grill.md` decision 6 (and the line in `.scratch/board-reset/spec.md` and "Shipped newest first"'s Further Notes saying this Story is absorbed) no longer hold: Shipped recently gets an automatic cut-off beside Reset board. The first Ticket adds a dated note under decision 6 pointing here.
- **Glossary.** The first Ticket updates `GLOSSARY.md`:
  - **Shipped history**: The page that lists every shipped Item, newest first, with archived Items marked; its Archived only view lists Resets, where Items can be unarchived.
  - **Shipped cut-off**: The whole-Kiln Setting that limits a board's shipped columns to Items whose ship time is within a window (1–30 days, or Off). A view rule only; it archives nothing. _Avoid_: auto-archive, expiry.
- **Suggested ticket order:**
  1. Core: `BoardSettings` type, `core_settings` row, `GET`/`PUT /api/board-settings` with access rules, audit and `board_settings.updated`, with the API tests. Glossary and the board-reset note.
  2. Shell: store `boardSettings`, `cutShipped` with unit tests, the cut on both boards with the minute clock, the Show all link and the empty line, the Settings page select, with Playwright tests.
  3. Shell: Shipped history's All shipped view and the Archived only toggle, with Playwright tests.
