# Review: 04 Week gauge signed gap to pace

Commit reviewed: 90dadc7 (the only commit on `kiln/ticket/usage-12h-guard/04`).

Verdict: **needs a fix round.** The core and Shell code are right. The Shell tests do not check the warning colour that the Ticket asks for.

`node --test packages/core/test/subscription.test.ts packages/shell/test/budgets.test.ts` passes (13/13) after a Shell build. I did not rerun the full `npm test`.

## What matches the Ticket

- `quota.ts:251-253`: gap = `Math.round(percent - elapsed)`. The label reads `· N under pace`, `· +N over pace` or `· on pace`, and the old `, pace N%` is gone. `Math.round(-0.4)` gives `-0`, and `-0 === 0` is true, so that case correctly reads "on pace".
- `paceGap` is signed (`percent - elapsed`), set only on the week window when `resetsAt` is known, and added to `QuotaWindowState` in widget-sdk with a doc comment. The label example in that comment is updated.
- `aheadOfPace` and the pace hold are unchanged. The hold's Ask text in `subscription-rules.ts` still says "pace N%". That text is not the gauge label, so leaving it is fine.
- `Usage.tsx:29` adds `warn` when `paceGap > 0`.
- The old label assertions are updated, and the expected numbers are right: 45 − 28.57 → +16, 95 − 94.0 → +1, 10 − 28.57 → 19 under.

## Findings

### 1. The under-pace "no warning colour" assertion checks nothing (must fix)

`packages/shell/test/budgets.test.ts:113`:

```ts
assert.doesNotMatch(..., /bwarnb/);
```

The backslashes are gone: this should be `/\bwarn\b/`. It was probably lost in the same Python write that corrupted `·`, which the build Digest mentions. As written, the regex looks for the literal text `bwarnb`, so the test passes even when the week gauge has `warn`.

### 2. No test shows the over-pace warning colour (must fix)

The Ticket asks for a Shell test of the "under- and over-pace labels and warning colour". The only over-pace Shell test is the existing header test at `budgets.test.ts:73`, and it has two gaps:

- It checks the label only, not the class.
- Its gap is +16, which is above the default `paceAhead` of 10. There, `aheadOfPace` already adds `warn`, so even a class check would not exercise the new `paceGap > 0` path.

Add a case where the gap is between 1 and `paceAhead`, for example 35% used at 28.57% elapsed (+6, the Ticket's own example). Assert that the label reads `· +6 over pace` and that the week `.budget-window` has the `warn` class (`/\bwarn\b/`).

### 3. Small edge: warning colour while the label reads "on pace" (minor, optional)

The label rounds the gap but the class does not. A gap in (0, 0.5) shows "· on pace" in the warning colour. The spec says the warning colour shows "when the gap is over 0 (the label has a `+`)", which assumes the two always agree. To make them agree, either:

- base the class on the rounded gap: `Math.round(w.paceGap ?? 0) > 0`; or
- store `paceGap` rounded in core, which makes it match the label; the spec only asks for it to be signed.

## Open

- The full `npm test` rerun from the build Digest (a story-flow timeout under load) has still not been confirmed by a reviewer.
