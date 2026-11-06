---
title: Move cards up and down in Up next
epic: board-ux
stage: grill
blocked-by: []
---
The person wants to say what starts next without editing priorities by hand: each card in the Up next queue gets up and down controls (and drag on a wide screen), and the new order is the start order the scheduler follows. The API already takes an order (`PUT /api/scheduler/queue {order}`); this Story is the board side, on the phone first.

## To grill

- Up/down buttons, drag, or both; what the phone shows on a narrow card.
- "Move to top" as well as one step at a time?
- Does a moved card keep its place when new work joins the queue, and over a restart?
- Ticket order inside a Story: can a Ticket move above its Story's earlier Tickets, or only Stories move?
