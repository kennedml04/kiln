# 01: Persist Session state and rework the boot path

**What to build:** Add sessions-table columns (resume token, pool slot, local attempt Variant/model, interrupted, pending Permission decision, pause reason, crash-resume count, failed-resume count) with a migration (existing rows null/zero). Replace the boot cleanup that marks live Sessions stopped: paused-for-restart => marked to resume, paused-by-Stop-all stays paused, waiting stays waiting with its Ask open, running => marked for one crash-resume, no token => failed-resume path. Resumed Sessions keep id, Item, Stage, worktree, branch, base and slot. Test through startTestKiln, no table assertions.

**Blocked by:** None

**Status:** in-review

**Stage:** review
