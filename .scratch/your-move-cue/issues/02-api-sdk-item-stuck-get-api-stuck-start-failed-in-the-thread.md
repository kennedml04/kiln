# 02: API/SDK: Item.stuck, GET /api/stuck, start_failed in the Thread

**What to build:** Add `stuck` to Item in packages/widget-sdk (set only when every Stuck condition holds; runState unchanged), the StuckItem type and GET /api/stuck (newest first), and add scheduler.start_failed to THREAD_TYPES so each failure shows in the Item's Thread only. Core tests: pool-missing Item gets stuck and a Thread entry, Start press fixes it, failed Start updates reason and adds a second entry, moving Stage clears it, fake Agent worktree-in-the-way reason. Depends on the Stuck mark Ticket.

**Blocked by:** None

**Status:** needs-triage
