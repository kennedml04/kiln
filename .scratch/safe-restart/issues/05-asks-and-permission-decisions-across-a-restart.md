# 05: Asks and Permission decisions across a restart

**What to build:** A Session waiting on a blocking or Permission Ask stays waiting with its Ask open across a restart. Answering resumes it via SessionStart.resume with the answer as message; a Permission answer goes in permission ('your <action> was allowed/denied') and an allowed action is pre-allowed once so the retried call doesn't ask again. Persist the pending Permission decision until the resumed Session has started.

**Blocked by:** None

**Status:** needs-triage
