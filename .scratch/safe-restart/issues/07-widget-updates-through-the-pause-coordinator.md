# 07: Widget updates through the pause coordinator

**What to build:** Widget updates drain only that Widget's Sessions via the coordinator (same limit, Restart now, Cancel), hold new Sessions only for that Widget, and publish the same events naming the Widget id. The new Widget version takes back stored resume tokens and resumes the Sessions. Tests: other Widgets' Sessions keep running and starting.

**Blocked by:** None

**Status:** needs-triage
