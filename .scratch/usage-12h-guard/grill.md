# Grill: a runaway guard of 20% of the week in any 12 hours

Grilled 2026-11-05. The person's answers came through Kiln Asks; the griller decided the technical details marked *(griller)*.

## Root cause of the bad per-Session check

`perSession.share` really does use attributed deltas (`quota.ts` `attribute`/`sessionShare`). The problem is how it detects a reset. It counts a reading pair as a reset when `after.resets_at` differs from `before.resets_at` and is later. The live week readings carry a `resets_at` that moves by under a second between calls: on 2026-11-06 (UTC) it read `09:00:00.293Z`, `.500Z`, `.957Z` and so on, giving 185 distinct values over 1010 readings since 2026-10-30. When a pair is taken for a reset, the change is the whole reading (22), so one Session got the account-wide 22% credited to it. `rate_limit_event` readings carry `.000Z` and a null percent, so they're skipped already.

**Fix *(griller)*:** a reset only counts when `resets_at` moves later by more than an hour (a real week or 5-hour reset moves it by days or hours). Otherwise the pair is an ordinary delta. The guard is built on this fixed attribution.

## Decisions

1. **What it measures: Kiln's attributed share only.** This is the sum of attributed week shares (reading deltas split across Kiln turns by tokens) over the window. A reading change with no Kiln turns in it is the person's own use and counts toward nothing. The week total never enters the comparison.
2. **Rolling window**, covering any 12-hour span. *(griller)* A change counts if the later reading of its pair was taken within the last `guard.hours`. The total is re-checked after each stored reading and on a timer, so it falls as old changes roll off.
3. **Budget-wide only**, not per Project. **The per-Session share limit is removed**: drop `session-share` from the subscription limits, and drop `perSession.share` from `SubscriptionBudgetConfig`, its defaults and validation. Older configs that still carry it are ignored, not rejected. The per-Session turn limit stays.
4. **When it trips, everything pauses.** All the Budget's work stops: running Sessions are held (nothing is killed) and new starts are held. It raises one blocking Ask with two options:
   - **"Continue for another N%"** (N = `guard.share`). The guard re-arms at the current 12-hour total plus N and releases the held Sessions.
   - **"Stop"** ends the paused Sessions.

   Thread messages the person sends still go through, as with the other holds. *(griller)* After Stop, new starts stay held with no new Ask until the rolling total falls below the threshold. The re-armed mark goes back to `guard.share` once the rolling total falls below it.
5. **Admin settings on each subscription Budget:** `guard.share` (percent of the week, default 20, 0 = off) and `guard.hours` (whole hours 1 to 168, default 12). They go beside `reserve` and `paceAhead`.
6. **On the board, always on, beside the week gauge:** "Kiln, last 12h: 6% of 20 · 14 left". It shows in the warning colour within 5 points of the limit, and in the alarm colour with the Ask link when it trips. It shows the room left, not a signed gap to pace, because the guard has a cap and no pace line.
7. **The week gauge's signed gap to pace ships in this Story** ("22% used · 18 under pace", "+6 over pace" in the warning colour), as the story described.
8. **The pace rule stays as it is**: it holds new unattended Sessions behind its weekly Ask. Reserve and overage rules are unchanged.

## Shape *(griller)*

- Built as a new rule in `subscription-rules.ts` (`rule: 'guard'`, a `holdAll`-style hold) fed by a new `QuotaStore` method that returns Kiln's attributed week share since a time. It is not a `usage.ts` limit, because those are per-scope caps and not rolling.
- A window with no readings in the span counts 0. Kiln never estimates.
- Fable and 5-hour readings don't count. Only the week window is the "weekly plan".

## Tests the build must have

- A Session whose attributed delta is small never trips the guard, even when the account week reading is high (for example 90%), with `resets_at` jittering by milliseconds between readings.
- Week readings rising more than `guard.share` with no Kiln turns between them (the person's own use) don't trip it.
- Kiln-attributed changes over `guard.share` within `guard.hours` pause running Sessions, hold new starts, and raise one Ask. More readings don't raise a second Ask.
- "Continue for another N%" releases the held Sessions, and the guard trips again only at the old total plus N. "Stop" ends the paused Sessions.
- Changes older than `guard.hours` roll off: the same total spread over more than 12 hours doesn't trip.
- `guard.share` = 0 turns the guard off. Bad values are rejected with a 400.
- `perSession.share` is gone: no `session-share` limit, and an old config carrying it still loads.
- Shell: the 12-hour figure with the room left, its warning and alarm colours, and the week gauge's signed gap to pace.

## Open

- None the person needs to answer. The *(griller)* choices above (the one-hour reset tolerance, behaviour after Stop, the re-arm reset) are the builder's to revisit if the code shows a better fit.
