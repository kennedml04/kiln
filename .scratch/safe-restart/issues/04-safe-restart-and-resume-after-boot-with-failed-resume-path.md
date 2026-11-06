# 04: Safe Restart and resume after boot, with failed-resume path

**What to build:** Replace Restart when idle with the safe Restart: POST /api/core/restart ({now?}), POST /api/core/restart/now, DELETE /api/core/restart (Admin only), remove restart-when-idle routes and update access.ts. kiln restart and kiln restart --now; kiln status shows pending counts and time left; doctor-cli fix text says Restart. After boot, resume marked Sessions in pool slots in start order before the scheduler starts anything, post 'Resumed after the restart', publish core.restart_resumed {resumed, failed}. Failed resume: one retry, then the Session ends with a Thread note, keeps commits/worktree, Item goes to the front of Up next. Local-model Sessions resume on the same Variant (missing Variant = failed); Project Thread Sessions resume in their cwd. Move existing Restart when idle tests (operations, cli-operations, demo) to the new behaviour.

**Blocked by:** None

**Status:** needs-triage
