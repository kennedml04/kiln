# Review: 10, Local-only: retry on other variants, then propose a split

## Second review, 2026-11-05 (branch at 30802a8, master at 41bf70f)

**Still not done. Send back.** `git diff --stat master...HEAD` shows only the issue file and this review. No code under `packages/` or `widgets/`. All four acceptance items are still not started. The last implementing Session left an empty Digest and made no commits after aef9aa6.

### Earlier findings, now

| # | Finding | Now |
| --- | --- | --- |
| 1 | Block note out of date about 07 | **Fixed, apart from wording.** The note now says 07 has code on its branch and isn't on master. It ends with a repeated sentence, "Also blocked by 08.", which the note has already said. Delete it. |
| 2 | 08 has no code | **Still true.** `kiln/ticket/local-first/08` (fb3a87f) changes only `.kiln/*` and its review. Its second review says it is still blocked by 03 and 07. |
| 3 | `Blocked by:` missing 08 | **Fixed** (aef9aa6): `**Blocked by:** 07, 08`. |
| 4 | `blocked` isn't a triage label | **Fixed.** Status is `ready-for-agent`, and the block is recorded on the `Blocked by:` line. |
| 5 | Status will conflict on merge | **Still open.** master says `in-review`, this branch says `ready-for-agent`. Keep `ready-for-agent`. |

### New findings

1. **The dependency chain is longer than the note says.** 10 waits on 07 and 08. 08 waits on 03 and 07. None of 03 (f707a5d), 07 (7b00517) or 08 is an ancestor of master (`git merge-base --is-ancestor` fails for each). "Re-run once both are on master" is right, but it means 03 has to be merged first.
2. **07's review sent it back, and its must-fix hits this Ticket directly.** 07's `planLocal` sets the Session's `model` to `variant.serverModelId`. 03 identifies a local Session by its variant **id**. Once both are merged, a local-only Session would go to the cloud Agent. That breaks story 13 ("no Session in it starts on a cloud model") and this Ticket's fourth acceptance item. When 10 is built, its harness test should check that every retry Session, and the ticket-writer split Session, reached the local-variant Agent with a `local` block. Checking only that the model isn't the cloud one is not enough.
3. **Suggestion: don't make 10 wait on all of 08.** Escalation is off in local-only mode (story decision 6). 10 needs only two parts of 08: the failure seed (failed diff plus check output) and the per-attempt records. If 08 stays stuck, move those two parts into a small Ticket that both 08 and 10 depend on, so 10 doesn't wait for cloud escalation. This is the person's call. It is not a defect in this branch.
4. **Repeat runs aren't helping.** This is the third Session on this Ticket that ends with no code, and 08 has the same pattern. Until 03 and 07 are merged, Kiln should keep 10 out of Implementing, not keep moving it between Implementing and Review.

### Next steps

- Fix 07's must-fix (use the variant id, rebase onto 03), then merge 03 and 07.
- Build 08, or split out the seed and attempt-record Ticket from finding 3.
- Then build 10 from master. Before merging this branch, delete the repeated sentence in the note.

---

## First review

Reviewed 2026-11-05. Branch `kiln/ticket/local-first/10` against `master`.

## Verdict

**Not done. Changes requested.** The branch builds nothing. Its only change is to the issue file (commit 3a33402): the Status goes from `ready-for-agent` to `blocked`, with a note. None of the four acceptance items is met, so the Ticket can't pass review.

The person chose to block the Ticket (Ask ask-238494bb, "Block 10; redo 07 and 08 first"), so the empty branch is expected. The findings below are about whether the block is recorded correctly and what has changed since it was recorded.

## Acceptance list

| Item | State |
| --- | --- |
| A local-only failure retries 2 more variants, each seeded with the earlier failures (harness test) | Not started |
| After the third failure, a blocking Ask shows the attempts and a proposed split | Not started |
| Accept split writes the new Tickets; Reword and Park do what they say | Not started |
| The setup wizard completes a local-only install with no cloud Budget | Not started |

## Findings

1. **The block note is already partly out of date.** It says 07 and 08 "have no code on any branch". `kiln/ticket/local-first/07` now has code: commit 0486642, "Role modes, results and the variant picker (local-first 07)", made at 18:10, after the block at 17:47. It adds `packages/core/src/local/{picker,routing,routes,variants,variant-picker}.ts`, the role mode in the validator and `session-manager.ts`, plus `role-modes.test.ts` and `variant-picker.test.ts`. Its issue file is marked `resolved` with every box ticked. 07 is not on `master` yet, but half of the block's reason no longer holds. **Fix:** change the note to say 07 is waiting for review or merge and 08 has no code.

2. **08 still has no code.** `kiln/ticket/local-first/08` changes only `.kiln/policy.json` and `.kiln/settings.json`. Its issue file is still `ready-for-agent` with no boxes ticked, but `master` lists 08 as `in-review`. That status is wrong. Fixing it belongs on 08's branch, not here, but it is the reason this Ticket stays blocked.

3. **`Blocked by:` lists only 07, but the note names 07 and 08.** If 08 really is a dependency, add it to the line. Kiln and the tracker read that line, not the prose. It probably is: retrying "seeded with the failures so far" needs 08's seed (the failed diff plus the check output) and its per-variant attempt records. Story decision 6 turns escalation off in local-only mode, but the seed and the attempt records are still needed. **Fix:** `**Blocked by:** 07, 08`.

4. **`blocked` is not a triage label.** `docs/agents/triage-labels.md` defines five labels, and `blocked` is not one of them. No other tracker file uses it. The repo already records blocking on the `Blocked by:` line, so the usual status here would be `ready-for-agent` (or `needs-triage`) with that line saying what it waits on. This is minor. If the person wants `blocked` as a status, add it to the triage-labels doc.

5. **Merging will conflict on the Status line.** On `master` the line now reads `in-review`, which is also wrong because nothing was built. On this branch it reads `blocked`. Whoever merges has to choose one. It should not be `in-review` while the Ticket has no code.

## Next steps

- Review and merge 07 (`kiln/ticket/local-first/07`).
- Implement 08. Its branch holds only policy and settings edits.
- Then re-run 10 from `master`. It needs the retry loop over the picker's next 2 variants, the local ticket-writer split proposal, the blocking Ask (Accept split, Reword, Park, with Accept split writing through the Tracker), and the wizard finishing with no cloud Budget. Each needs the harness tests the acceptance list asks for.
