# Review: 05 Guard figure on the board

Branch `kiln/ticket/usage-12h-guard/05` at 663f93f, compared with `master` (56085a7).

## Verdict: not done. Send back to Implementing.

The branch has none of the ticket's work. `git diff master...HEAD` holds only the merge of ticket 01 (a757ba0): the one-line reset-detection fix in `packages/core/src/budgets/quota.ts` and two tests in `packages/core/test/subscription.test.ts`. Both build Digests say the same: the ticket was blocked on 02 and 03 and nothing was started.

## Findings

1. **No `guard` on BudgetInfo or the rollup.** `GET /api/budgets` returns no `guard {used, limit, left, hours, warn, tripped, askId, label}` for a subscription Budget, and nothing is pushed on the gauge events. Missing.
2. **No `budget-guard` span in `packages/shell/src/work/Usage.tsx`.** No meter, no "Kiln, last 12h: N% of 20 · M left" label, no `warn` or `alarm` class, no link to the Ask. Missing.
3. **No alarm colour in `packages/shell/src/styles.css`.** `git grep alarm` finds none on the branch or on master. Missing.
4. **No Shell tests** for the figure, the warning state or the alarm state (spec testing decision 10). Missing.
5. **The blocker is gone.** Master now has ticket 02 (guard settings in `widget-sdk/src/budgets.ts`, `SUBSCRIPTION_DEFAULTS.guard`) and ticket 03 (`QuotaStore.attributedSince` and the guard rule in `subscription-rules.ts`, merged at 54bd6d6). The `quota.hold` and `quota.released` events already include `'guard'` in `rule`. The next build should merge master into this branch first. Ticket 01's fix is already on master through 03, so that merge should be clean, and then it can build on `attributedSince` and the guard state.
6. **Week pace-gap warning (ticket 04) is still separate.** The spec's Shell `warn` on `paceGap > 0` needs ticket 04's `paceGap`, which isn't on master. It isn't part of this ticket's What-to-build, so don't count it against 05.

## What was checked

- The ticket 01 changes on the branch are correct and match master's version: reset = `resets_at` moving later by over an hour. A NaN from a missing `resets_at` compares false, so the pair is treated as an ordinary delta. Its tests cover jitter (89→90 attributes 1) and a real reset (attributes 3).
- I didn't run the tests. With no ticket 05 code there is nothing new to run them against.
