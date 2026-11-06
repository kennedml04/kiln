---
title: Show a running Session's steps in its Thread, folded by default
epic: board-ux
stage: spec
blocked-by: []
---
A Ticket's Thread is concise, which is worth keeping, but while a Session works it shows little, and the person can't tell it is moving. Opening a Ticket should show its Session's steps as they happen (what it read, ran, edited, and short reasoning notes), each folded to one line with a +/- to expand, so there is visible movement without the Thread turning into a transcript.

## To grill

- Which steps show: tool calls only, the Agent's own short notes between them, or both?
- Folded per step, or one "Steps (42)" group per turn that opens into lines that each open again?
- Live while running (SSE), and kept after the Session ends, or dropped at the end?
- A "still working" pulse or last-step time on the card itself, so movement shows without opening it?
- Privacy: steps can name files and commands; the same rules as the Thread.
- The phone layout: one line per step, tap to expand.
