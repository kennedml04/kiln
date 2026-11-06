# 04: Shell: Needs you "Your move" section and Thread note

**What to build:** Add a "Your move" section above the Asks in Needs you: one entry per Stuck Item (title link, Project, Stage, reason, time, Start button disabled while in flight, error shown under it if the Start fails and the entry stays with the new reason). Header count = open Asks + Stuck Items; "Nothing needs you" only when both are empty. Render scheduler.start_failed in the Item Thread as "Kiln could not start <Stage>: <reason>". Tests in packages/shell/test/your-move.test.ts: listing above Asks, count, clears on start, failing Start keeps the entry, Thread text.

**Blocked by:** None

**Status:** needs-triage
