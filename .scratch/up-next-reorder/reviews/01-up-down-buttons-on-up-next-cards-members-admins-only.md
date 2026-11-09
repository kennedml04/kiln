# Review: 01 Up/down buttons on Up next cards (Members/Admins only)

Second review. It replaces the first one (commit a801ac6, which reviewed 51f0d8b).

Reviewed the branch `kiln/ticket/up-next-reorder/01` at ea551f5 (`packages/shell/src/work/HomeBoard.tsx`, `packages/shell/src/work/StoryCard.tsx`, `packages/shell/src/styles.css`, `packages/shell/test/scheduler.test.ts`) against the Ticket and the spec.

Verdict: **request changes.**

## What happened to the implementation

The commit the first review approved, 51f0d8b, is not on this branch. No branch contains it: it is a dangling object. Since then the branch has taken the Story-first queue work (8d38be1 and later). That work rewrote `UpNext` to show `StoryCard`s in Story order, and it brought its own minimal ▲ ▼ (`StoryCard.tsx:62-71`, `HomeBoard.tsx:76-80`). The branch's only commit for this Ticket (ea551f5) adds the review file. The code the Ticket asks for is not here.

So this review covers what the branch has now: the Story-card ▲ ▼.

`node --test packages/shell/test/scheduler.test.ts` gives 6 pass, 0 fail.

## Checked against the Ticket

| Ticket asks for | State on the branch |
|---|---|
| ▲ ▼ in the card's top-right corner at every width | Done. `.story-card .story-move` is absolutely positioned, with no media query. |
| 44px hit areas | **Missing.** The buttons are `padding: 0 0.3rem; font-size: 0.7rem; line-height: 1.4`, about 16 × 16 px. |
| aria-labels "Move <title> up/down" | Done. |
| `draggable=false` on the buttons | **Missing.** The buttons sit inside the `draggable` `<article>`, with no `draggable={false}` and no `dragstart` guard. On desktop, a press that moves slightly can start a card drag. |
| Title padding so the buttons never cover the title | **Missing.** `.item-card h4` has no right padding in Up next, so a long Story title runs under ▲ ▼. |
| `move(id, to)` sends the whole shown order through the same path as `dropBefore` | Partly. `move(index)(direction)` swaps two places and calls the shared `send`. That is fine for one step. Ticket 02's Move to top will need the `to`-index form. |
| Only ids the queue knows | Not applicable any more. The ids come from `scheduler.stories`, and the PUT takes Story ids, so a card the core doesn't know can't be shown. |
| No optimistic reorder | Done. |
| Every button disabled while a PUT is in flight | **Missing.** There is no busy state. Two quick presses each compute from the same stale order. |
| First ▲ / last ▼ disabled | Done (`canMove`). |
| Error in the column alert, cleared by a later success | Done. `send` clears the error before each PUT. |
| Focus stays on the moved card's button, or its other one if that is disabled | **Missing.** Nothing restores focus. React moves the keyed wrapper `div` on reorder, so the focused button can lose focus. |
| Hidden for Viewers | **Missing.** `UpNext` always passes `onMove`. A Viewer sees the buttons and gets a refused PUT when pressing one. |
| Tests on 390 × 844: ▼ moves the first card second (page and GET), disabled ends, new Ticket joins last, Viewer sees none, refused move shows the error, drag still passes on wide | **Mostly missing.** One `Move Story Newer down` click is tacked onto the drag test, on the default (wide) viewport, and it checks only the page order. There are no phone-viewport tests, no disabled-ends test, no new-work-joins-last test, no Viewer test and no error test. The drag test passes. |

## Findings

### 1. The Ticket's implementation is missing from the branch (blocking)

Redo the Ticket on top of the current Story-card `UpNext`, not by cherry-picking 51f0d8b. That commit was written against Item cards and `scheduler.queue` item ids, and both have since been replaced by Story entries. 51f0d8b is still useful as a reference for the CSS, the busy lock and the focus handling (`git show 51f0d8b`). Where the code lives is up to the implementer: the controls are already in `StoryCard` behind `onMove`, so keeping them there is fine, as long as only `UpNext` passes `onMove`.

### 2. Viewers see the controls (blocking)

In `HomeBoard.tsx:93`, pass `onMove` only when `me.role` is `admin` or `member`, the same test `App.tsx` uses.

### 3. Touch target, title overlap and drag (blocking for the phone)

In `styles.css:2321`, give each button at least 44 × 44 px of hit area; the glyph can stay small. Pad the Up next card's `h4` on the right by the group's width. In `StoryCard.tsx:64-69`, set `draggable={false}` and prevent `dragstart` on the buttons.

### 4. No in-flight lock and no focus handling (should fix)

Add a `busy` flag in `UpNext` that disables every ▲ ▼ while the PUT is in flight. Keep focus on the moved card's button after the reorder. When doing so, mind the race the first review found: the PUT reply can land before `scheduler.updated`. Restore focus only once the shown order reflects the move (or the PUT failed), and then choose the button that is still enabled.

### 5. Tests (blocking)

Add the Ticket's tests at 390 × 844: ▼ on the first card (page order and `GET /api/scheduler`), disabled ends, new work joining last with the moved order unchanged, a Viewer seeing no buttons, and a refused move showing the error. Also worth adding: focus after a move, and buttons disabled during a held PUT (`page.route`). Keep the existing drag test on wide.

## Note on the old review

The old version of this file (a801ac6) described code that is not on the branch. It also had broken characters: the ▲ ▼ × symbols were saved as mojibake. This version replaces it.
