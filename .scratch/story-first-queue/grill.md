# Grill: Story-first board

Grilled with the person in chat on 2026-11-07. All six open questions in `story.md` were settled; each answer was the recommended option.

## 1. Is the in-flight limit per Project, box-wide, or both?

**Decided: both.**

- A per-Project limit, default 2 Stories at the tickets stage, set in that Project's Settings.
- A box-wide cap equal to the agents pool size, so two Projects cannot together put four Stories in flight for two agents.
- Both limits sit beside the pools in Settings.

## 2. A Story whose remaining Tickets are all blocked or waiting on the person

**Decided: it holds its slot while its Tickets are blocked by each other, and frees it when the only thing left is the person's move.**

- Tickets blocked by other Tickets of the same Story resolve on their own as those ship; the Story keeps its slot.
- When every remaining Ticket of the Story is in Needs you (an Ask, a Gate, a "Your move" Stage), the Story frees its slot and the next Story in the person's order may start.
- When the person answers, that Story takes the next free slot ahead of any Story that has not started yet.

## 3. Does the queue-order API take Story ids?

**Decided: Story ids are the stored order.**

- `PUT /api/scheduler/queue {order}` takes Story ids per Project. The Ticket start order is derived: Story order, then Ticket number, respecting `Blocked by`.
- Every client (Shell, standup, others) reads the same derived order, so they cannot drift.
- The old Ticket-level call stays for one release as a shim: a Ticket id is mapped to its Story and the Story is moved.

## 4. Tickets of one Story: strict number order, or two at once?

**Decided: two unblocked Tickets of the same Story may run at once.**

- Anything not marked `Blocked by` is safe to parallelise; real dependencies are already recorded on the Ticket.
- A Story never holds more agents than the pool size minus one, so a second Story always gets a turn.
- With the pool at 2 this means at most one extra Ticket of the same Story.

## 5. A Ticket filed without a Story

**Decided: one auto-created Maintenance Story per Project.**

- The board makes it when the first Story-less Ticket appears; it never ships.
- It counts toward the in-flight limit like any other Story and can be dragged in Up next, so it is not a back door to the old round-robin.
- Its card reads "3 shipped, 1 open" rather than "of N".

## 6. What the all-Projects board shows when grouped by run state

**Decided: Stories only, with the running Ticket as a one-line sub-row; Needs you shows the Ask.**

- Running: the Story card with its running Ticket's title beneath.
- Needs you: the Ask itself, labelled with its Story's title and the Story's why line, because the Ask is what the person acts on.
- Up next: Stories in the person's order.
- Shipped recently: Stories; a Ticket appears on its own there only when its Story is Maintenance.

## Other decisions from the chat

- The agents pool was set to 0 on 2026-11-07 so no new Tickets start until this Story is specced and ticketed. Set it back to 2 when this Story's Tickets are ready to run; planners and reviewers were left as they were.
