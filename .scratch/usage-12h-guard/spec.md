# Spec: A runaway guard of 20% of the week in any 12 hours

Status: ready-for-agent

Sources: `.scratch/usage-12h-guard/story.md`, `.scratch/usage-12h-guard/grill.md` (the grill decisions of 2026-11-05, numbered 1–8 below as they are there), and the code as of branch `kiln/story/usage-12h-guard` (2cc299b). Quota readings and attribution live in `packages/core/src/budgets/quota.ts`; the subscription window rules (pace, reserve, overage) in `packages/core/src/budgets/subscription-rules.ts`; the subscription config, its defaults and validation in `packages/widget-sdk/src/budgets.ts` and `packages/core/src/budgets/kinds.ts`; the header gauges in `packages/shell/src/work/Usage.tsx`.

## Problem Statement

- The per-Session share of the week (`perSession.share`) paused ordinary Sessions and the person answered its Asks every time. It was raised from 5% to 20%, then to 100% (off in effect), as a stopgap.
- It was also wrong. On 2026-11-05 it asked "Session share of the week reached (22 of 20 % of week)" on a fix-round Session when the account's whole week reading was 22%. The cause is reset detection in `quota.ts` `attribute`: a pair of readings counts as a reset whenever `after.resets_at` differs from `before.resets_at` and is later. The live week readings carry a `resets_at` that jitters by under a second between calls (`09:00:00.293Z`, `.500Z`, `.957Z`…; 185 distinct values over 1010 readings since 2026-10-30). A pair taken as a reset credits the whole reading (22) as new use, so one Session was charged with the account's whole 22%.
- What the person actually wants is a guard against runaway spend across the whole Budget: if Kiln's Sessions together use more than 20% of the weekly plan within any 12 hours, the work pauses and one Ask comes up. Otherwise Kiln stays quiet and the person watches usage themselves.
- The week gauge shows "22% used, pace 40%", so the person has to subtract to see how far from pace they are.

## Solution

1. **Fix reset detection.** A pair of readings is a reset only when `resets_at` moves later by more than one hour. Anything else is an ordinary delta. All attribution (rollups, Session shares, the guard) uses the fix.
2. **Remove the per-Session share limit.** The per-Session turn limit stays.
3. **Add a runaway guard to each subscription Budget.** It sums Kiln's attributed share of the week window over a rolling `guard.hours` (default 12) and compares it with `guard.share` (default 20, percent of the week). When the sum goes over, all the Budget's work pauses behind one blocking Ask: **"Continue for another N%"** or **"Stop"**. The person's own use outside Kiln never counts.
4. **Show it on the board, always:** "Kiln, last 12h: 6% of 20 · 14 left" beside the week gauge, warning colour within 5 points, alarm colour with the Ask link when tripped.
5. **Show the week's gap to pace as a signed number:** "22% used · 18 under pace", or "+6 over pace" in the warning colour.

## User Stories

### The guard

1. As the person, when Kiln's Sessions together use more than 20% of the week within 12 hours, I want all the Budget's work paused and one Ask raised, so a runaway can't eat my week while I'm away.
2. As the person, I want my own use of the plan outside Kiln not to count, so working in Claude myself never pauses Kiln.
3. As the person, I want the window to be any 12-hour span, not fixed halves of the day, so a burst across midday or midnight still counts as one burst.
4. As the person, I want "Continue for another 20%" to let the work go on and only ask again if it uses another 20%, so I'm not asked again a minute later.
5. As the person, I want "Stop" to end the paused Sessions, and new work not to start again by itself until the 12-hour total has fallen back under the limit.
6. As the person, I want to keep sending Thread messages while the guard holds, as with the other holds.
7. As the person, I want only one Ask per trip, however many readings come in afterward.

### Settings

8. As an Admin, I want to set the guard's share and hours on each subscription Budget, beside `reserve` and `paceAhead`, and set the share to 0 to turn it off.
9. As an Admin with an older Budget config that still has `perSession.share`, I want it to keep loading.

### Seeing it

10. As the person, I want to see Kiln's 12-hour use and the room left at all times, next to the week gauge, so I know how near the guard is.
11. As the person, I want the week gauge to tell me how far under or over pace I am, so I needn't subtract.

### Fewer false alarms

12. As the person, I never want a Session that used little to be paused because the account's week total is high.

## Implementation Decisions

### Reset detection (root cause)

- In `quota.ts` `attribute`, replace the reset test with: `reset = Date.parse(after.resets_at) - Date.parse(before.resets_at) > 3_600_000` (both present and parseable). A real week or 5-hour reset moves `resets_at` by hours or days; jitter moves it by milliseconds. *(griller; the builder may revisit the one-hour figure if the code shows a better fit.)*
- Otherwise the change is `after.percent - before.percent`, skipped when ≤ 0, as now.
- Readings with a null percent (`rate_limit_event`) are already excluded by `windowReadings`; keep it that way.

### Removing the per-Session share (decision 3)

- `SubscriptionBudgetConfig.perSession` becomes `{ turns: number }`. Drop `share` from the type, from `SUBSCRIPTION_DEFAULTS` and from `subscriptionKind.configure`.
- `configure` ignores a `perSession.share` it is given (an old stored config or an old client). It does not reject it, and does not carry it into the result.
- `subscriptionKind.limits` drops `session-share`; `session-turns` stays.
- Update the `"perSession" must be {share, turns}` error text and the defaults' doc comment.
- If `sessionShare` on `QuotaStore` has no other caller once the limit is gone, remove it. Leave the `usage.ts` `quota` measure alone if other code still uses it; otherwise remove that too.

### Guard settings (decision 5)

- `SubscriptionBudgetConfig` gains `guard: { share: number; hours: number }`. Defaults `{ share: 20, hours: 12 }`.
- `configure` validates: `guard.share` with `percentPoints(..., { allowZero: true })` (0 = off); `guard.hours` a whole number from 1 to 168. Anything else is a 400 naming the field. A missing `guard` (or a missing field in it) takes the default, so existing Budgets get the guard on upgrade.
- Set through the existing `PUT /api/budgets/:id` (Admin). There is no Shell form for subscription config today, so this Story adds none.

### Kiln's attributed share since a time (decision 1, 2)

- New `QuotaStore` method: `attributedSince(budgetId, config, window, since: Date): number`, the sum of every Kiln turn's attributed share of the window's changes over reading pairs whose later reading was taken at or after `since`, in percent points.
- It is built on `attribute`, which already gives nothing to a change with no Kiln turns in it. Only the `week` window feeds the guard; the 5-hour and Fable windows don't count.
- No readings in the span: 0. Kiln never estimates.
- The pair's later reading's `taken_at` decides whether a change is in the window. A change that straddles the edge counts whole or not at all.
- If `attribute` over all readings gets slow, the builder may limit the query to readings since `since` plus the one before it. The result must be the same.

### The guard rule (decision 4)

- A new rule in `subscription-rules.ts`: `Rule` gains `'guard'`, and the header comment describes it beside pace, reserve and overage.
- **When it is checked:** after each stored reading for the Budget (where the other rules run) and on the existing timer, so the total falls and a hold's state updates as old changes roll off.
- **The mark:** per Budget, in memory, starting at `guard.share`. The guard trips when `attributedSince(now - guard.hours) > mark`. When `guard.share` is 0 it never trips and the board shows no guard figure.
- **On a trip:** `holdAll(budget, 'guard', 'week', at, ask)`: running Sessions are held (nothing is killed) and new starts are held. One blocking Ask:
  - Question: `${name}: Kiln used ${total}% of the week in the last ${hours} hours, over its ${mark}% guard. Continue all ${name} work?`
  - Why: `Kiln paused all the Budget's work; nothing was stopped. Your own use outside Kiln doesn't count.`
  - Options: `Continue for another ${guard.share}%` and `Stop`.
- A hold keyed `[budget, 'guard', 'week']` already exists while the Ask is open, so later readings don't raise a second Ask (the `holdAll` key does this for the other rules).
- **Continue for another N%:** the mark becomes the current rolling total plus `guard.share`; the hold is released as other holds are (`release`). No waiver row is written: the guard isn't waived for the week.
- **Stop:** `stopAll(hold)` ends the paused Sessions. *(griller)* Afterward new starts stay held, with no new Ask, until the rolling total falls to or below the mark. Implement as a "stopped" state on the Budget's guard that `held()` honours and the timer clears.
- **Re-arm reset** *(griller)*: once the rolling total falls to or below `guard.share`, the mark goes back to `guard.share`.
- Guard state lives in memory like the other holds. After a core restart the mark is `guard.share` again and the guard is re-checked on the next reading or tick. This can raise the Ask again after a restart if the total is still over; that's acceptable.
- `quota.hold` and `quota.released` event types in `widget-sdk` gain `'guard'` in their `rule` union.
- The pace, reserve and overage rules are unchanged (decision 8).

### Guard state for the board (decision 6)

- `QuotaRollup`/`BudgetInfo` for a subscription Budget gains a `guard` object, `null` when `guard.share` is 0:
  - `used` (rolling total, rounded for display), `limit` (the current mark), `left` (`max(0, limit - used)`), `hours`, `warn` (`left <= 5` and not tripped), `tripped` (a guard hold or the stopped state exists), `askId` (the open Ask, if any), `label` (`Kiln, last 12h: 6% of 20 · 14 left`, with the configured hours).
- Computed where the window states are computed for `GET /api/budgets`, and pushed on the same events that refresh the gauges today.

### Week gauge's gap to pace (decision 7)

- In `quota.ts` window state, the week label becomes `Week: 22% used · 18 under pace, resets in 2d 3h` or `Week: 46% used · +6 over pace, …`; exactly on pace reads `· on pace`. The gap is `round(percent - elapsed)`.
- Add `paceGap: number` (signed, `percent - elapsed`) to `QuotaWindowState` for the week window, so the Shell can colour it without parsing the label.
- The warning colour shows when the gap is over 0 (the label has a `+`). The existing `aheadOfPace` (gap over `paceAhead`) still drives the pace hold and its own warning.

### Shell (decision 6, 7)

- `Usage.tsx` `WindowGauges`: right after the week window, when `budget.guard` is set, show a `budget-guard` span with a `<meter min=0 max={limit} value={used}>` and the label. Class `warn` when `guard.warn`, class `alarm` when `guard.tripped`, and when tripped a link to the Ask (as the other held states link to theirs).
- The week window's label already comes from core; add the `warn` class when `paceGap > 0`.
- Add the `alarm` colour to `styles.css` if it doesn't exist, in the dark theme first.

## Testing Decisions

All tests drive Kiln from outside (`startTestKiln`, the fake Agent reporting quota readings, `openShell`); none assert on internal modules or tables. Each one below comes from the grill's required tests.

1. **Small Session, high week total:** readings rise from 89% to 90% across one Session's turns, with `resets_at` jittering by milliseconds between readings. The Session is never paused and no guard Ask is raised. A reading pair with jittering `resets_at` is attributed its delta (1), not the whole reading (90): check the Budget's rollup.
2. **The person's own use:** week readings rise by more than `guard.share` with no Kiln turns between them. No trip, and the board's guard figure stays at 0.
3. **Trip:** Kiln-attributed changes over `guard.share` within `guard.hours` pause the running Sessions, hold a newly dispatched Item, and raise one blocking Ask. More readings after that raise no second Ask.
4. **Continue:** "Continue for another 20%" releases the held Sessions. More attributed use under old total + 20 doesn't trip; going over it does, with a new single Ask.
5. **Stop:** "Stop" ends the paused Sessions. A new Item stays held, with no new Ask, until the clock moves on and the total falls under the mark; then it starts.
6. **Roll-off:** the same attributed total spread over more than 12 hours (the clock advanced between bursts) doesn't trip, and the board's figure falls as old changes leave the window.
7. **Real reset still counts:** a pair whose `resets_at` moves by days credits the new reading as all new use.
8. **Settings:** `guard.share = 0` turns the guard off (no trip at any use, no figure on the board). Bad values (`guard.share` −1 or 101, `guard.hours` 0, 169 or 1.5, a non-number) return 400. A missing `guard` takes the defaults.
9. **`perSession.share` gone:** a Budget PUT with `perSession: { share: 5, turns: 150 }` succeeds and the stored config has no `share`; the limits list has no `session-share`; a Session over 5% attributed share isn't paused for it.
10. **Shell:** the header shows "Kiln, last 12h: N% of 20 · M left" next to the week gauge; warning colour within 5 points; alarm colour and the Ask link when tripped. The week gauge shows "· N under pace" and "· +N over pace" in the warning colour.

The clock is the test core's injectable clock, as the pace and 5-hour reset tests use today.

## Out of Scope

- A per-Project guard (decision 3: Budget-wide only).
- Counting the 5-hour or Fable windows toward the guard.
- A Shell form for editing subscription config; the guard is set through the API like `reserve` and `paceAhead`.
- Changes to the pace, reserve or overage rules (decision 8).
- Storing guard state across a core restart.
- Metered and local Budgets: the guard is for subscription Budgets only.

## Further Notes

- The live Budget has `perSession.share` at 100 as the stopgap. After this ships it's ignored on load and the guard applies with the defaults (20% in 12 hours) unless the person sets other values.
- The *(griller)* choices (the one-hour reset tolerance, behaviour after Stop, the re-arm reset) are the builder's to revisit if the code shows a better fit; record any change in the build Digest.
