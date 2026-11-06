# Grill: Move cards up and down in Up next

## What is already there

- `PUT /api/scheduler/queue {order}` (`packages/core/src/flow/scheduler.ts` `reorder`) gives the listed Items descending priorities above every unlisted entry. The queue is ordered `priority DESC, seq`.
- Wide screens can already drag: in `UpNext` (`packages/shell/src/work/HomeBoard.tsx`), dropping a card on another moves it just before that one and sends the whole order. Drag does nothing on a phone.
- The queue is a database table, so the order survives a restart with no change.

## Decisions

1. **Controls: up/down buttons at every width, plus drag on wide screens** (the person's answer). Each Up next card gets small ▲ ▼ buttons in its top-right corner, with aria-labels ("Move <title> up" / "down"). The top card's ▲ and the bottom card's ▼ are disabled. Drag stays as it is.
2. **Move to top: yes, behind a long-press on ▲ or a small menu** (the person's answer). The card shows only ▲ ▼. Holding ▲ (about 500 ms, touch or mouse) moves the card to the top. The spec picks long-press or a menu; the move must also work from the keyboard. No "Move to bottom".
3. **Ticket order: any card moves anywhere** (the person's answer). There is no rule about a Ticket's Story or its Blocked by. The scheduler does not enforce Blocked by today, and enforcing it is a separate Story, not the board's job.
4. **A moved card keeps its place when new work joins, and over a restart.** The current core already does this, so the core needs no change:
   - Every button press sends the whole visible order, like drag does.
   - New entries join at priority 0, below every reordered card. With no reordering, the queue is first in, first out.
   - An Item that starts leaves the queue. When it re-enters at its next Stage, it joins at the bottom like any new work.
   - The order is stored in the `queue` table, so a restart keeps it.

## Notes for the spec

- Up next is one list across pools, and the scheduler starts the first card whose pool has room. Moving a card above one in another pool changes nothing until both pools are full. That is expected, so the board shows no hint.
- Held cards (a guard holds them) keep their place and can still be moved.
- If the PUT fails, show its error under the column as drag does now. The board reorders from the `scheduler.updated` event and does not reorder optimistically.
- Tests: Shell tests through `openShell` on a narrow viewport. Press ▼ on the first card and check the order and `GET /api/scheduler`. Long-press ▲ moves a card to the top. The ▲/▼ at the ends are disabled. The order still holds after a new Item joins.

## Open

- Long-press on ▲ or a small ⋯ menu for Move to top. The spec picks one; either way the keyboard needs a path.
