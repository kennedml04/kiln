# 01: Core: run.lastStepAt on every session.progress, throttled

**What to build:** Add optional lastStepAt (ISO) to ItemRun in packages/widget-sdk/src/flow.ts. In session-manager routeAgentEvents, on each progress event set it on the live session info (not the DB) and call work.setRun(itemId, toRun(info)); toRun copies it. Throttle to one item.updated per Session per 5s: first step publishes at once, a trailing timer publishes the latest value, timer cleared when the Session ends. Test through the API/SSE with the fake Agent: a burst of steps gives at most one item.updated per 5s and the final value is the last step's time.

**Blocked by:** None

**Status:** needs-triage
