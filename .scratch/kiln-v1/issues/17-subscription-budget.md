# 17: Subscription Budget

**What to build:** The Budget kind for a flat plan like Claude Max, measured in plan usage, not dollars. Agents report quota readings (window, percent used, reset time), using the reading shape confirmed by ticket 03. Kiln stores every reading, always at the start and end of each Session. A Session's quota cost is the change in readings across its turns, split across concurrent Sessions in proportion to their tokens. The windows are the 5-hour window, the week, and Fable's own weekly allowance. The defaults:

- Per Session: 5% of the week or 150 turns, subagents included.
- Pace rule: when weekly percent used is more than 10 points ahead of the share of the week elapsed, no new unattended Session starts on this Budget, and a blocking Decision Ask recommends holding until it is back on pace. Running Sessions continue, and the person's own Thread messages always go through.
- Reserve: 10% of each window.
- At the 5-hour reserve, work pauses with a non-blocking Ask (recommendation: wait) and resumes by itself after the reset.
- At the weekly reserve, everything on the Budget pauses with a blocking Ask.
- At the Fable reserve, Sessions on Fable pause, and each affected Stage raises a blocking Decision Ask recommending its Workflow fallback model.

"Unknown" applies per window. A window with no reading shows "unknown", and its pace, reserve and auto-resume rules stay off; research found no 5-hour reading on the account tested. Readings are account-wide, so per-Session quota costs are labelled approximate. Signs of paid overage (overage in use, or the plan's used credits rising) count as reaching the window's limit: pause and raise a blocking Ask. See `docs/research/claude-code-quota-readings.md` and the spec's Budgets decisions. The header gauges show weekly use against pace, the time to reset, the 5-hour window and Fable. A Budget page shows use over the period by Project, Stage and Item kind, with Fable broken out.

**Blocked by:** 03, 15

**Status:** resolved

- [ ] Quota readings are stored, and each Session's quota cost is attributed, including when Sessions run concurrently
- [ ] The per-Session share cap pauses and asks
- [ ] Being ahead of pace stops new unattended Sessions and raises the hold Ask; Thread messages still go through
- [ ] The 5-hour reserve pauses work, which resumes by itself after the reset on the test clock
- [ ] The weekly reserve pauses everything on the Budget, and local or metered work keeps going
- [ ] The Fable reserve raises a fallback-model Ask for each affected Stage
- [ ] A window with no reading shows "unknown" and its rules don't fire, while the other windows keep working
- [ ] Overage in use, or used credits rising, pauses the work and raises a blocking Ask
- [ ] The header gauges and the Budget page show pace, time to reset and Fable usage by Project, Stage and Item kind
