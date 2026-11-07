---
title: Story-first board: the backlog is Stories, Tickets are a Story's checklist
epic: board-ux
stage: tickets
blocked-by: []
---
The person steers the board by Story, not by Ticket. Today Up next is one flat list of Tickets and the agents pull from it round-robin across Stories: on 2026-11-07 the queue read linked-projects/03, scratch-chat/05, pi-agent-widget/04, linked-projects/04, scratch-chat/06, pi-agent-widget/05 … six Stories interleaved, two agents nibbling at all six, none of them shipping. A Ticket card ("One Review Ask and landing across linked repos") says nothing about what it is for without its Story, so the person reads Tickets they never wanted to manage and still cannot tell what is close to done.

## What we want

- **The backlog is Stories, in the person's order.** The person drags Stories (and only Stories) in Up next and on a Project's board. A Story's stage (grill, spec, tickets, shipped) is the unit they steer. Epics are shelves: they group Stories on the board and in the standup and have no stage and no queue of their own.
- **A Story limit in flight, default 2 per Project.** The scheduler pulls Tickets only from the top N Stories at the tickets stage, in their numbered order (respecting `Blocked by`), and does not start a Ticket of the (N+1)th Story until one of the N ships. Finishing beats starting. The limit is a Setting beside the pools.
- **Tickets are the Story's checklist.** The Story card shows "4 of 9 shipped" and the one running or waiting Ticket's title. A Ticket card, wherever it appears (Running, Needs you, the Thread, the standup), names its Story and carries one line of why from the Story. The person opens a Ticket only when it needs them.
- **Tickets with no Story stay possible but rare.** A Ticket filed on its own (today's safe-restart/10 pattern) hangs on a per-Project "Maintenance" Story so the rule above still holds; the board makes that Story when the first such Ticket appears.
- **The standup follows.** "Kiln: Story A 6 of 9, Story B grilling, Story C up next" instead of a list of Ticket titles (`.scratch/standup/story.md`).

## Acceptance

1. With the limit at 2 and three Stories at the tickets stage, no Ticket of the third Story starts until one of the first two ships, even when the agents pool has room.
2. Reordering Stories in Up next changes which Tickets start next; Tickets cannot be reordered across Stories.
3. Every Ticket card and Ask on the board shows the Story's title and its why line.
4. A Story card shows shipped/total Tickets and the Ticket currently running or waiting.
5. A Ticket filed without a Story appears under the Project's Maintenance Story and is scheduled like any other.

## To grill

- Is the limit per Project, box-wide, or both? Two Projects each with two Stories in flight is four Stories for two agents.
- Does a Story in flight whose Tickets are all blocked or waiting on a person free its slot to the next Story, or hold it?
- Does `PUT /api/scheduler/queue {order}` take Story ids from now on, with Ticket order derived, or stay Ticket-level under the hood with the Shell hiding it?
- Should a Story's Tickets run strictly in number order, or may two unblocked Tickets of the same Story run at once (today's pool of 2 would otherwise idle one agent)?
- The Maintenance Story: one per Project, auto-created, never shipped; or a Ticket without a Story is simply refused?
- What the all-Projects board shows when grouping by run state: Stories only, with their running Ticket as a sub-line?

## Related

- `.scratch/up-next-reorder/story.md`: up/down controls in Up next. Under this Story those controls move Stories, not Tickets.
- `.scratch/standup/story.md`: the standup Widget reads the same Story-level view.
- `.scratch/churn-watchdog/story.md`: fewer Stories in flight also means fewer concurrent test runs.
