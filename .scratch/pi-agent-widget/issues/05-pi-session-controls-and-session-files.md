# 05: Pi Session controls and session files

**What to build:** Implement message (steer while running, follow-up when idle), interrupt (abort run; cancel any tool call held on an open Ask so it closes as "no longer needed"), resume (reopen the Pi session file kept in the Widget's data folder, keyed by Kiln Session id) and stop (abort and close; file stays until Kiln cleans up the Session).

**Blocked by:** None

**Status:** needs-triage
