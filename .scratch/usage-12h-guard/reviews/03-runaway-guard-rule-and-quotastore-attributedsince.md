# Review: 03 Runaway guard rule and QuotaStore.attributedSince

Reviewed commit 4e1f0c4 against the ticket and `spec.md`.

**Verdict: fix round needed.** One blocking bug: after "Stop", held Items don't start again on their own. One test checks too early to prove what it claims. The rest matches the ticket.

## Checks run

- `node --test packages/core/test/subscription.test.ts`: 15 of 15 pass, including the 5 new guard tests.
- `npm run typecheck`: clean. `npm run check`: clean.

## Findings

### 1. After Stop, held Items stay held once the total rolls off (blocking)

`packages/core/src/budgets/subscription-rules.ts:239` (`checkGuard`). When the timer finds the total at or below the mark, it removes the Budget from `guardStopped`. Nothing tells the scheduler or the board about it:

- `checkGuard` calls neither `poke()` nor `changed()` when it clears the stopped state.
- The rules' own 5-minute timer calls the internal `tick` (`subscription-rules.ts:317`), not `usage.ts` `rolledOver`. So nothing else pokes either.
- The scheduler has no periodic retry (`flow/scheduler.ts` only has `poke()`).

So in the live core, Items held in Up next behind a Stopped guard stay there after the 12-hour total has fallen. They start only when something unrelated pokes the scheduler: the midnight rollover, another start, or a reading from another Budget's Session. The board's `held` flag stays stale too, until the next `publishBudgets`. This breaks User Story 5 and spec test 5 ("…until the clock moves on and the total falls under the mark; then it starts").

The Stop test doesn't catch it, for two reasons:

- `setClock` goes through `clock.onChange` → `rolledOver`, which pokes. The real timer path doesn't.
- The test starts a fresh Item ('Later'), which runs `startHold` directly. It never checks that the Item already held ('Next') starts by itself.

**Fix:** in `checkGuard`, when `guardStopped.delete(budget.id)` actually removes an entry, call `changed()` and `poke()`. Then change the Stop test to wait for 'Next' to start (a `session.started` for `next.id`) after the clock moves, rather than starting 'Later'.

### 2. The Continue test's "under the new mark" check can pass without testing anything (should fix)

`packages/core/test/subscription.test.ts`, the Continue test, `await settle(events, 3)`. `events.next` takes buffered events in order. The `quota.recorded` events for wk(10) and wk(35) were never consumed, because the test waited only on `quota.hold`. So `settle(3)` returns after wk(10), wk(35) and wk(36). That can be before wk(50) is recorded.

Then the assertion `'40 of 45: under the new mark'` (no open guard Ask) can run before the reading it is about. The next step waits for "a" guard hold, and a wrong trip at wk(50) would satisfy that wait too. The test can therefore pass with a broken mark.

**Fix:** wait for the specific reading, e.g. `nextWhere(events, 'quota.recorded', (e) => e.payload.reading.percent === 50)`, before asserting. Wait for `percent === 70` before the last assertion. Test 3's "one Ask however many readings follow" has the same weakness: wait for the wk(36) reading, which comes only after release if the agent is held, or drop the claim.

### 3. `attribute` reads the Budget's whole reading history on every check (minor, not blocking)

`quota.ts` `attribute` with `since` still loads every week reading the Budget has ever stored (`windowReadings` has no time bound). It runs after every reading and every 5 minutes while a guard is on. It skips the per-pair `turnsBetween` query for pairs before `since`, so the cost is one table scan. That cost grows without bound: about 1000 readings a week today. The spec allows limiting the query to readings since `since` plus the one before. Worth doing when this area is next touched. No change is needed now.

### 4. Small points (no change needed)

- On the timer the guard re-arms the mark and lifts a Stop, but it can't trip, because it needs an Item for its Ask. Totals only rise on a reading, so nothing is missed. This is recorded in the build Digest, and I agree with it.
- `guard: []` passes validation and takes the defaults. The same is true of the existing `perSession` check. Harmless.
- The guard Ask's `recommendation` is `Stop`, like the other blocking holds. The spec doesn't say which to recommend.

## Against the ticket

| Ticket requirement | Status |
|---|---|
| `attributedSince(budgetId, config, 'week', since)`: later reading within the window, 0 if none | Done (`quota.ts:225`) |
| Rule 'guard' in the `Rule` type and the `quota.hold`/`quota.released` unions | Done |
| Checked after each stored reading and on the timer | Done (5-minute timer while a guard is on) |
| Trips when total > mark; mark starts at `guard.share` | Done |
| `holdAll` plus one blocking Ask with the spec's question, why and options | Done; the text matches the spec |
| Continue: mark = total + N, release, no waiver | Done |
| Stop: `stopAll`; new starts held with no new Ask until total ≤ mark | Held, and no new Ask, but **doesn't resume by itself** (finding 1) |
| Mark resets to `guard.share` when total ≤ it | Done |
| No second Ask while held | Done (the `holdAll` key; the test is weak, finding 2) |
| `guard.share` 0 = off | Done in code. Not tested here; spec test 8 belongs to ticket 02 |
| Tests for spec items 1–6 | All present; 3/4 and 5 need tightening (findings 1, 2) |

The reset fix and guard settings were added here because tickets 01 and 02 weren't on this branch. They match the spec. Expect a small merge overlap in `quota.ts` and `kinds.ts` with those tickets.
