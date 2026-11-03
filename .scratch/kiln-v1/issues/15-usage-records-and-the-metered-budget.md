# 15: Usage records and the metered Budget

**What to build:** Kiln records actual usage and enforces the first kind of Budget. Agents report usage per turn. Kiln stores one record per turn with: Session, parent Session (for subagents), subagent description, model, Budget, context size, cache reads, cache writes, output tokens, cost in the Budget's unit, API-equivalent USD, and the idle gap before the turn. Counting starts from the Session's first turn. Records roll up to Session, Item, Epic, Project, Stage, Item kind, day, week and month. Each model belongs to exactly one Budget. This ticket adds the metered kind: credits or money with a unit label and a rate to USD. The work default is 10,000 credits a month at 50 credits per dollar, 500 credits or 150 turns per Session (subagents included), and 1,250 credits per Project per day. The Item shows a warning at 50% of a cap. Hitting a cap pauses the work and raises a blocking Ask. Hitting the monthly limit pauses everything on that Budget and nothing else. Running Items show live usage in the Budget's unit, and the header shows the Budget's monthly gauge. Kiln never estimates. A test-only clock control on test instances (never on a live core) makes day and month roll-overs testable.

**Blocked by:** 06

**Status:** resolved

- [ ] Every reported turn is stored with all the listed fields, and subagent turns roll up to their parent Session and Item
- [ ] Roll-ups by Item, Epic, Project, Stage, Item kind, day, week and month are available through the API
- [ ] The per-Session, per-Project-per-day and monthly caps pause work and raise a blocking Ask; nothing is killed
- [ ] A warning shows on the Item at 50% of a cap
- [ ] The monthly limit pauses only work drawing from that Budget
- [ ] Running Items show live usage in credits plus tokens and context size, and the header shows the monthly gauge
- [ ] The test clock moves time on a test instance, and the live core has no such control
- [ ] No estimate is shown anywhere
