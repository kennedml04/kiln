---
title: A clear "Your move" cue when the person must start the next Stage
epic: board-ux
stage: spec
blocked-by: []
---
In the first Live demo run, the Story reached Spec / backlog after the grill and nothing started. It was not clear whether Start was usable or whether the board would start the next Stage by itself. Whenever the next step is the person's, Kiln should say so where it can't be missed: a card badge, a Needs-you entry and a Thread message. Or, for some Stages, it should start the next Stage itself after an Exit or merge.

## To grill

- Auto-start the next Stage after an Exit or merge, or always show a "Your move: press Start" cue, or a per-Stage setting?
- Which surfaces show the cue (card badge, Needs-you list, Thread, notification)?
- How the cue clears (Start pressed, the Item moved, dismissed).
