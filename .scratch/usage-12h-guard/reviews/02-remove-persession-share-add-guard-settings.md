# Review: 02 Remove perSession.share; add guard settings

Branch `kiln/ticket/usage-12h-guard/02`, base `master` at 118d32d. Commits ae76c10 (the work),
3010d81 (demo Replay test timeout), 1afa386 (merge fix after rebase). Reviewed against the ticket and
the spec's "Removing the per-Session share" and "Guard settings" sections.

`node --test packages/core/test/subscription.test.ts packages/core/test/budgets.test.ts`: 30 pass, 0 fail.

**Verdict: changes needed** (finding 1, now a blocker). This is round 2: the rework only resolved the
rebase conflict; none of round 1's findings were addressed (the rework Digest says so).

## What is right

- `SubscriptionBudgetConfig.perSession` is `{ turns }`; one `guard: { share, hours }` with defaults
  `{ 20, 12 }`; the defaults doc comment is updated (`widget-sdk/src/budgets.ts`). The rebase left one
  `guard` key in the type and the defaults, not two.
- `configure` ignores `perSession.share` and doesn't carry it; `guard.share` uses
  `percentPoints(..., { allowZero: true })`; `guard.hours` is a whole number 1–168; an array `guard` is
  now rejected; each bad value is a 400 naming the field; a missing `guard` or field takes the default;
  the `perSession` error text no longer mentions share (`core/src/budgets/kinds.ts:139-163`).
- `session-share` is gone from `limits`; `QuotaStore.sessionShare` (no other caller) is removed;
  `attributedSince` from master is kept.
- Tests cover PUT with `perSession.share` (no share stored, guard defaults), no `session-share` in the
  Budget info, `share: 0` accepted, and the bad `guard.share`/`guard.hours` values.

## Findings

### 1. Stored configs are not normalised on load; with the guard rule now on master this crashes (blocker)

Unchanged from round 1, but worse now that master carries the guard rule. `usage.ts:224-231`
`loadBudgets` returns `JSON.parse(r.config)` raw, and `asSubscription` (`usage.ts:585-586`) only casts
it. `configure` runs only on `PUT /api/budgets/:id`. The live Budget was stored as
`perSession: { share: 100, turns: … }` with no `guard`, so after this ships:

- `subscription-rules.ts:311` `schedule()` does `budgets().some((b) => b.config.guard.share > 0)`:
  a TypeError for that Budget, from every reading (`afterReading`) and every tick. Lines 226, 230 and
  421 read `config.guard` the same way.
- `GET /api/budgets` still shows `perSession.share` and no `guard`.

The spec: "A missing `guard` (or a missing field in it) takes the default, so existing Budgets get
the guard on upgrade", and "an old stored config … keeps loading". The ticket's "old config with
share still loads" test only goes through PUT, which isn't the load path.

Fix: in `loadBudgets`, run the kind's `configure` over the stored config (falling back to the raw
config if it throws, so one bad row can't take the core down). Add a test that reaches a stored
old-style row without a PUT (e.g. a Budget stored by the setup/seed path or a fixture data folder
with a pre-guard config, then restart the core) and checks `GET /api/budgets` shows
`guard: { share: 20, hours: 12 }`, no `share`, and that a quota reading is processed without error.

### 2. The `quota` limit measure is dead code but left in (minor)

Unchanged. No kind returns a `measure: 'quota'` limit now, yet `'quota'` stays in `LimitSpec.measure`
(`kinds.ts`, with its doc comment and `window?`), the `used = 0` branch (`usage.ts:273-276`) and the
`% of week (approximate)` unit text in `usage.ts`. The spec says remove it if unused; the guard is a
rule in `subscription-rules.ts`, not a limit, so nothing will reuse it. Remove it, or say in the
Digest why it stays.

### 3. No behavioural test that a Session over the old share isn't paused (minor)

Unchanged. Spec test 9: "a Session over 5% attributed share isn't paused for it". The replacement
test checks config and the absence of the string `session-share` only. Reuse the deleted test's
script (`week(10), turn, week(12), turn, week(14)`, with `perSession: { share: 4 }` and the guard off
or high) and assert no `budget.limit_reached` and the Session still running.

### 4. Stale `perSession: { share: 50 }` in a Shell test (nit)

`packages/shell/test/budgets.test.ts:60`. Harmless (ignored) but it existed only to keep the removed
limit from tripping; drop it.

### 5. Setup wizard label hard-codes "12 hours" (nit)

`SetupWizard.tsx:29`: "share of the week in 12 hours" though `guard.hours` can be set. Fine while the
wizard only writes defaults; either say "in the guard's hours" or read the draft's `guard.hours`.

### Unrelated change on the branch

3010d81 raises the demo Replay test's Ask wait to 180 s. Not this ticket's work; the rework Digest now
records it, which is enough.
