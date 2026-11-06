# Review 11: The GPU queue and its cutoff

Reviewed 2026-11-05, branch `kiln/ticket/local-first/11` against `master` (merge base 8881b14).

## Verdict

**Not built. The ticket should stay blocked, but its blocker note needs fixing.** The branch has one commit (874c923). It changes only the issue file, setting `Status: blocked` and adding a note. No code or tests changed. None of the three acceptance boxes is met.

## What the branch changes

- `.scratch/local-first/issues/11-gpu-queue-and-cutoff.md`: Status `ready-for-agent` → `blocked`, plus the "Blocked 2026-11-05" note.

## Acceptance list

| Box | Met? | Notes |
|---|---|---|
| A second local Session waits while the first holds the GPU slot, and its card says so | No | Mostly there already (see Finding 2). The card text is what's missing. |
| A short test cutoff sends a waiting local-first Ticket to cloud as "GPU busy", and no variant's record changes | No | Needs 08's escalation path, which has no code yet. |
| A local-only Ticket waits past the cutoff | No | Needs 07's role modes (now on a branch) and the cutoff timer. |

## Findings

### 1. The blocker note is partly wrong, and partly out of date

The note says "07 and 08 have no code on any branch, and 03 is not merged." As of this review:

- **03** had code when the note was written. `kiln/ticket/local-first/03` (and `local-first-03`) merged local Sessions at 17:27 (57ec80a: 505 lines, including `widgets/claude-code/test/local-session.test.ts`). The note was committed at 17:57. "Not merged" means not on master, which is true. But the implementer's Digest says 03 has no code on any branch, and that is wrong.
- **07** now has code. `kiln/ticket/local-first/07` gained 0486642 "Role modes, results and the variant picker" at 18:10, after the block (684 lines: `packages/core/src/local/routing.ts`, `picker.ts`, `role-modes.test.ts`, `widget-sdk/src/variants.ts`). It isn't on master yet.
- **08** still has no code. Its branch only has review/tracker commits (ac74e13 "Review 08: not built, still blocked by 03 and 07").

So the real blocker now is **08 (escalation)**, plus 03 and 07 being merged to master. Update the note to say that, so whoever unblocks it doesn't wait on work that's already done.

### 2. The queue mostly exists already; the block was too wide

`LOCAL_POOL` is `'gpu'` (`packages/widget-sdk/src/budgets.ts:135`), the same name as the GPU monitor Widget's pool (`widgets/gpu-monitor/kiln-widget.json:9`). The local Budget already claims it for its Sessions (`packages/core/src/budgets/local.ts:28`, wired through `scheduler.addPoolClaim(usage.poolsFor)` at `packages/core/src/server.ts:203`). `widgets/gpu-monitor/test/gpu-pool.test.ts:76` already shows a second GPU-bound Session queuing in arrival order and starting when the first ends.

That has two consequences:

- Box 1 depended only on 03 (to make a Session local) plus a "waiting for the GPU" reason on the Up next entry and card. `scheduler.ts` has no wait-reason field today. That part could have been built on top of the 03 branch instead of blocked outright. It's an option to weigh when this is redone, not a defect.
- The ticket says a local Session takes "`LOCAL_POOL` and one slot of the GPU monitor's `gpu` pool" as if they were two pools. They are one pool under one name. Whoever builds this must check how the scheduler merges a Budget's pool with a Widget's pool of the same name: the Budget's size (`LOCAL_POOL_SIZE = 1`) or the Manifest's / Admin's, and whether the Session takes one slot or two. Add a test for it. The ticket text should also say it's one pool.

### 3. Things to carry into the rebuild (not defects in this branch)

- The cutoff has to be clock-driven and testable with a short value. Make the Setting overridable in tests (seconds, or an injected clock) so the test doesn't sleep for minutes.
- "GPU busy" escalation must not write to the variant's results. The test should read the scoreboard before and after and assert it hasn't changed (box 2 says "no variant's record changes").
- A local-only Ticket past the cutoff should keep its place in the queue. Assert its queue position or arrival order, not just that it didn't escalate.
- Story 23: no code path may lower the variant on a busy GPU. A test that a busy GPU never changes the picked variant would cover it cheaply once 07 lands.

## Recommendation

Keep Status `blocked`, but rewrite the note: blocked by 08 (no code), and by 03 and 07 merging to master (both have code on their branches). Optionally, split box 1 (queue + card text) into work that can start once 03 merges.

## Second review (2026-11-05, after the second implementing pass)

The second implementing Session changed nothing: its Digest is empty and the branch has no new commits. The branch is still df22aa8 plus this review (8afbfbe). Against `master` (merge base 58b9010) it changes only the issue file (the blocker note) and this file. No code and no tests.

- **Finding 1 is fixed.** The note in df22aa8 now reads as this review asked: "08 (escalation) has no code on any branch. 03 … and 07 … have code on their branches but are not merged to master", and it points out that the queue mostly exists already. It matches the branches today.
- **The blockers haven't moved.** `kiln/ticket/local-first/08` still has nothing under `packages/` or `widgets/` against master (its last commit, fb3a87f, is "Review 08 again: still not built"). 03 (57ec80a, 505 lines) and 07 (0486642, 684 lines) are still not ancestors of master.
- **All three acceptance boxes are still unmet.** Findings 2 and 3 still stand for the rebuild: LOCAL_POOL and `gpu` are one pool, so test how the Budget's and the Widget's pools merge. The cutoff needs a test clock. Assert the scoreboard is unchanged after a "GPU busy" escalation. A local-only Ticket keeps its queue place. A busy GPU never changes the picked variant.

**Verdict:** not built, and correctly blocked. Leave it blocked until 08 has code and 03 and 07 are on master. Another implementing pass before then will only repeat this one.
