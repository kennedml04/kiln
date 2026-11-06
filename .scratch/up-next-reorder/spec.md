# Spec: Move cards up and down in Up next

Status: ready-for-agent

Sources: `.scratch/up-next-reorder/story.md`, `.scratch/up-next-reorder/grill.md` (decisions 1–4 below are numbered as they are there), and the code as of branch `kiln/story/up-next-reorder` (3def633). Up next is the `UpNext` component in `packages/shell/src/work/HomeBoard.tsx`; cards are `ItemCard` in `packages/shell/src/work/ItemCard.tsx`; the order is set by `reorder` in `packages/core/src/flow/scheduler.ts` behind `PUT /api/scheduler/queue {order}`.

## Problem Statement

- The person wants to say what starts next. Today the only way to change Up next's order on the board is drag, and drag does nothing on a phone, where the board is used most.
- Without the board, the order can only be changed through the API or by editing priorities by hand.

## Solution

Every card in Home's Up next column gets small **▲** and **▼** buttons in its top-right corner, at every width. ▲ moves the card one place up, ▼ one place down. **Holding ▲** (500 ms, touch or mouse) moves the card to the top; from the keyboard, **Shift+Enter** or **Shift+Space** on ▲ does the same (Shift+click too). There is no Move to bottom and no third visible control. Drag stays as it is on wide screens.

Any card may move anywhere: there is no rule about a Ticket's Story or its Blocked by (decision 3).

Each move sends the whole visible order to `PUT /api/scheduler/queue`, as drag does. The core needs no change: a moved card keeps its place when new work joins (new entries join at priority 0, below every reordered card) and over a restart (the order is the `queue` table) (decision 4).

## User Stories

### Moving one step

1. As a Member on my phone, every Up next card shows ▲ and ▼ in its top-right corner, each a full-size tap target (at least 44 × 44 CSS px of hit area, even if the glyph is smaller), not covering the title.
2. As a Member, pressing ▼ on a card swaps it with the card below; pressing ▲ swaps it with the card above. The new order shows once the core confirms it (the `scheduler.updated` event), and it is the start order the scheduler follows.
3. As a Member, the top card's ▲ and the bottom card's ▼ are disabled. With one card in Up next, both are disabled.
4. As a Member on a wide screen, the buttons are there too, and dragging a card onto another still moves it before that one.

### Move to top

5. As a Member on my phone, holding ▲ for about half a second moves the card to the top of Up next. Letting go before that is a normal one-step ▲. A hold that moved the card to the top does not also move it one step on release.
6. As a Member, holding ▲ with the mouse works the same way.
7. As a keyboard user, Shift+Enter or Shift+Space on a focused ▲ moves the card to the top; Enter or Space alone moves it one step. Shift+click does the same with a mouse.
8. As anyone, ▲'s tooltip and accessible description say "Hold, or Shift, to move to the top", so the gesture can be found.
9. As a Member on my phone, holding ▲ does not open the browser's context menu, select text or start a drag.

### Keeping the order

10. As a Member, after I move a card, new work that joins Up next goes below every card I've moved, so my order holds. If I never move anything, Up next stays first in, first out.
11. As a Member, the order I set is still there after Kiln restarts.
12. As a Member, a card that starts leaves Up next; when it comes back for its next Stage it joins at the bottom like any new work.
13. As a Member, a held card (a guard is holding it) keeps its place and its ▲ ▼ work like any other.

### Errors and roles

14. As a Member, if a move fails (for example the card started a moment before), the error shows under the column, as for drag, and the board stays in the order the core reports.
15. As a Viewer, Up next shows no ▲ ▼ buttons (the API refuses `queue.reorder` for Viewers already).

### Focus

16. As a keyboard user, after a move my focus stays on the same button of the moved card. If that button is now disabled (the card reached the top or bottom), focus moves to the card's other button.

## Implementation Decisions

### Where the controls live

- `UpNext` renders the controls, not `ItemCard`: `ItemCard` is shared by every column. `UpNext` wraps each card (it already wraps each in a `div` for drop targets) and places a small `.reorder` group, absolutely positioned in the card's top-right corner. The card's title gets enough right padding inside Up next that the buttons never cover it (a modifier class on the wrapper, e.g. `.up-next-card`).
- Buttons are real `<button type="button">`s with `aria-label="Move <title> up"` / `"Move <title> down"`. ▲ also has `title` and `aria-description` "Hold, or Shift, to move to the top" and `aria-keyshortcuts="Shift+Enter"`.
- The buttons set `draggable={false}` and stop `dragstart` so pressing them never starts a card drag on desktop.
- Dark-theme first, like the rest of the Shell; the buttons use the existing muted-control colours and a visible focus ring.

### Who sees them

- `UpNext` reads `me` from the store and shows the controls only when `me.role` is `admin` or `member` (the same test `App.tsx` uses for Stop all). Drag is unchanged in this Story.

### Computing and sending the order

- One helper in `UpNext`, `move(id, to)`, where `to` is a target index in the visible list. It builds the order from the cards as shown, moves `id` to `to`, and sends it, sharing the send-and-error path with `dropBefore`. ▲ is `to = index - 1`, ▼ is `index + 1`, Move to top is `0`.
- The order sent lists only Items that are in the scheduler's queue (`scheduler.queue`), in the shown order. Up next can briefly show a card the queue doesn't know yet (it sorts last); it is left out of the order rather than making the PUT fail with 409. Such a card's buttons are disabled.
- No optimistic reorder: the board moves when `scheduler.updated` arrives, as drag does now.
- While a move's PUT is in flight, every ▲ ▼ in the column is disabled, so two quick presses can't each compute from the same stale order. They re-enable when the PUT settles.
- On failure, the PUT's message is shown in the column's existing `role="alert"` paragraph. A later successful move clears it.

### Long-press

- Long-press is handled with pointer events on ▲: `pointerdown` starts a 500 ms timer; `pointerup`, `pointercancel` and `pointerleave` clear it. When the timer fires it calls `move(id, 0)` and marks the press as used, so the following `click` is swallowed.
- ▲ sets `touch-action: none`, `user-select: none` and `-webkit-touch-callout: none`, and prevents `contextmenu`, so a hold on a phone doesn't select, scroll or open a menu.
- Keyboard and Shift: the `click` handler reads `event.shiftKey`; Shift moves to top, otherwise one step. Enter and Space fire `click` on a button natively, carrying Shift.
- No vibration or animation is required. If the top card's ▲ is disabled, holding it does nothing.

### Core

- No core change. `reorder` already gives the listed Items descending priorities above every unlisted entry; new entries join at priority 0; the queue is a database table. Pools and guards are unaffected: Up next is one list across pools, and moving a card above one in another pool changes nothing until both pools are full. The board shows no hint about that.

## Testing Decisions

Shell tests through `openShell` in `packages/shell/test/scheduler.test.ts`, set up like the existing drag test (fake Agent waiting, `agents` pool size 1, one Busy Ticket running and others queued). Run the new ones on a narrow (phone, e.g. 390 × 844) viewport. Assert through the page and `GET /api/scheduler`, never internal modules.

1. Pressing ▼ on the first Up next card moves it to second: the cards' order on the page and `state.queue` item ids both change.
2. The first card's ▲ and the last card's ▼ are disabled; the others are enabled.
3. Holding ▲ on the last card (pointer down, wait past 500 ms, up) moves it to the top, and only to the top: it does not then step one place down or up.
4. Shift+Enter on a focused ▲ moves its card to the top; Enter alone moves it one step.
5. After a move, starting a new Ticket so it joins Up next puts it last, and the moved order above it is unchanged.
6. A Viewer sees no ▲ ▼ buttons in Up next.
7. A move whose card has just left the queue shows the core's error under the column.
8. The existing drag test still passes on a wide viewport.

Restart keeping the order needs no new test: it is the `queue` table, which existing core tests cover.

## Out of Scope

- Enforcing Blocked by in the scheduler (a Ticket starting before a Ticket it is blocked by). That is a possible separate Story.
- Move to bottom.
- Reordering on a Project's board; Up next is only on Home.
- Drag on touch screens.
- Hiding drag from Viewers.

## Further Notes

- The grill left open whether Move to top sits behind a long-press on ▲ or a small ⋯ menu. This spec picks long-press, because the person asked that the card show only ▲ ▼; the keyboard path is Shift on ▲, and the tooltip names both.
