# Grill: Churn watchdog — notice Sessions that run for hours and put them in Needs you

Story: "Churn watchdog: notice Sessions that run for hours and put them in Needs you". Grilled 2026-11-06, one Ask per question.

## What happened

On 2026-11-06 seven Implementing Sessions ran for two to three hours each on twenty-minute Tickets. Their test runs were slow because six others ran at the same time, `tests_pass` failed, Kiln sent Exit feedback, the Agent re-ran the suite, and the loop repeated: 24 failed `tests_pass` checks between 02:16 and 04:00 and no passing one. The Running column looked healthy.

## What the code already does

- The runaway guard (`packages/core/src/budgets/runaway.ts`) has a stall rule: `stallTurns` (8) main-thread turns with no new commit or artifact change, or `repeatedToolCalls` (3) identical tool calls in a row. When it fires, it holds the Session and raises a blocking Continue / Stop Ask (`raisedBy: { kind: 'runaway' }`). An unmet `exit.checked` counts as a turn.
- It missed this case, most likely because the Agents committed small fixes between test runs, and each commit resets the idle count. Watches are also per Session, so a context-alarm renewal starts the count over.
- After unmet Exit feedback, `session-manager.ts` gives up only if the Agent does nothing for `EXIT_IDLE_MS`. A busy Agent is never stopped.

## Decisions

1. **Trigger: both rules, whichever fires first.**
   - *Unmet checks in a row:* the same Exit check fails N times in a row for the Item in this Stage, whatever the Agent commits in between. Default N = 3.
   - *Wall clock:* the Item has spent longer than a time limit in this Stage's Sessions. Default 60 minutes.
   - Both are new fields in the runaway settings (`GET/PUT /api/runaway`), editable like the existing thresholds.
2. **Action: pause, then a Continue / Stop Ask.** Reuse the stall-rule mechanism: hold the Session (nothing is killed) and raise a blocking decision Ask in Needs you with the options Continue and Stop, recommending Stop. The Ask says which rule fired and includes the last failing check's name and detail. Continue releases the hold and resets the counts and the clock. Stop ends the Session.
3. **Scope of the counts: per Item per Stage visit, running time only.** The count and the clock carry over to fresh Sessions of the same Item in the same Stage (context-alarm renewals, restarts). They reset when the Item changes Stage or a person presses Continue. Time counts only while a Session is running, not while it is paused, waiting on an Ask, or queued in Up next, so Stop all and Asks don't use up the clock.
4. **The board shows churn before the watchdog fires.** A Running card shows how long it has been in this Stage (running time, as in decision 3). Once a check has failed it also shows an "Exit not met ×N" badge, with the failing check's name on hover. N counts unmet checks in a row; when one check passes, the run is broken and the badge goes away.
5. **Watchdog only.** The root cause (test suites slowing each other down) is out of scope. Follow-up story: *serialize command Exit checks*. Run `tests_pass` and module command checks one or two at a time per Project, and show "waiting for a test slot". That story could also put fuller failure output in the Exit feedback, so the Agent doesn't re-run the suite to see why.

## Implied behaviour

- A Session already paused by the stall rule is not raised again by the watchdog (one open runaway Ask per Session).
- The watchdog applies to every Stage that runs a Session, not only Implementing.
- "Same check in a row": if a different check fails, or the Exit is met, the run starts over.

## Decisions from the second Session (2026-11-06)

6. **The counts are stored.** The per-Item-per-Stage counts (unmet checks in a row, running time in the Stage) live in the core's database, so a core restart (for example Restart when idle) does not give a churning Item a fresh N and a fresh 60 minutes. The Running card's elapsed time and "Exit not met ×N" badge read the same stored numbers. They are not rebuilt from events, and they are not kept in memory only like today's stall rule.
7. **Extend `session.stalled`.** `StallRule` (`packages/widget-sdk/src/runaway.ts`) gets two new values: `'exit'` (the same check unmet N times in a row) and `'time'` (the running-time limit). The watchdog publishes `session.stalled` and uses the stall hold (`runaway:stall`) and the runaway Ask recipient, so anything that already handles stalls picks it up. There is no separate event.
8. **No new glossary term.** The watchdog's two rules are stall rules, so `GLOSSARY.md` **Stall** now describes them (and no longer says "There is no separate cap on Exit rounds"). "Churn" is used only as the story's name, not as a defined term.
9. **Follow-up story filed:** `.scratch/serialize-exit-checks/story.md` (stage `grill`). `.scratch/test-run-lock/` already caps full test runs for this repo with a slot wrapper in its `npm test` and raises the Exit check timeout to 45 minutes. The follow-up covers what that story leaves out: core-side slots for command Exit checks in any Project, "waiting for a test slot" on the card, and fuller failure output in the Exit feedback.

## Notes for the Spec

- The new settings go through `mergeSettings` in `packages/core/src/budgets/runaway.ts`. Both are whole numbers of 1 or more (checks, and minutes), so they fit its existing check. Suggested names: `exitUnmetInRow` (3) and `stageMinutes` (60).
- Today's watches are per Session and live in memory (`watches` Map, deleted when a Session ends). The new counts are keyed by Item and Stage visit, so a context-alarm renewal or restart keeps them.
- `exit.checked` carries `exit.stage` and `exit.checks` (`ExitCheckResult[]`), so the Stage and the failing checks come from the payload. When several checks fail in one round, the Spec should count each check's own run (any check reaching N fires the rule) and not need the whole set to repeat.
- Queued time for an Exit check, once `serialize-exit-checks` exists, is not running time (decision 3).
