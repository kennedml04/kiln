# 03: Pause coordinator with Stop all and Stop now

**What to build:** Build the pause coordinator (drain: scope, reason, deadline from a core setting, default 10 min, end action) replacing operations/restart.ts. Sends pause_after_turn, posts Thread notes, interrupts at the deadline or on Restart now, supports Cancel (Sessions resume in place), holds new Sessions in scope via a stable reason code the scheduler matches instead of 'waiting to restart', and publishes core.restart_pending/cancelled/restarting events. Stop all pauses after the turn; add Stop now (POST /api/scheduler/stop-now, Member) that interrupts at once; resume works with a cold cache. Depends on the Session state and SDK tickets.

**Blocked by:** None

**Status:** needs-triage
