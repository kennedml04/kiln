# 06: Crash and reboot recovery

**What to build:** After an unplanned stop, Sessions that were running resume on next boot with 'carry on where you left off' and the note 'Resumed after Kiln stopped unexpectedly'. At most one crash-resume per Session; a second unplanned stop sends it down the failed-resume path so a crashing Session can't loop. Test by killing the core process without a restart, twice.

**Blocked by:** None

**Status:** needs-triage
