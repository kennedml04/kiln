# 10: A finished Session's Claude Code process holds its worktree

**What to build:** Found in the first Live run (09). The griller Session finished and met its Exit, but its `claude.exe` (a child of the Claude Code Widget) kept running with its working folder inside the Story's worktree. On Windows a process's working folder can't be deleted, so `mergeOnExit` merged the branch and then failed on `git worktree remove --force` ("Permission denied"). The Item stayed at Grill with only a Thread message, "Kiln could not finish the Stage: …". Nothing retried it, and moving the card by hand is refused (correctly), so the person is stuck. Fixed by hand by stopping the process, removing the worktree and setting the stage in `story.md`.

The grill paused and resumed around its blocking Asks ("Agent finished (interrupted)" then "(completed)"), so a resumed Session may leave the first `claude.exe` behind.

It happened on every merging Stage of the run, not only the Grill. At a Gate (Spec, Tickets, both Reviews) it shows as an approval loop: the first approval merges, the cleanup fails, and the review Ask is raised again; later approvals re-merge as a no-op and fail the same way. Two Tickets left four `claude.exe` behind between them. The hand fix at Grill also left the Item's run record on the finished grill Session, and the board gave no clear sign that Start was the person's move.

Three parts:
1. The Claude Code Agent ends its `claude.exe` when a Session finishes (closes the SDK query and waits for the process to exit), including any process an interrupt left behind.
2. `removeWorktree` (`packages/core/src/flow/git.ts`) retries a few times on Windows "Permission denied" before failing.
3. A Stage finish that fails after the merge doesn't strand the Item. The core finishes what's left (cleanup, advance) on a retry or at the next start, or it raises a blocking Ask with a Retry.

**Blocked by:** None

**Status:** resolved

**As built:** A finished Session's `claude.exe` stays up on purpose, so a follow-up Thread message resumes it while its cache is warm. It is ended when its Item merges instead: the Gate (and `mergeOnExit`) releases the Item's finished Sessions first (`SessionManager.releaseItem`), and the Claude Code Agent's stop closes the query and waits up to 5 s for the process to exit before it reports "stopped". A Session started again under the same id closes the earlier run first. `removeWorktree` retries for about 7 s. A merge whose cleanup still fails publishes `item.cleanup_failed` and moves the Item on; the next `ensureWorktree` on that branch replaces the stale worktree. A branch already merged into the default branch is not merged again.

- [x] No `claude.exe` is left running in a worktree after its Session finishes, interrupted-and-resumed Sessions included (ended at the merge, see above)
- [x] A worktree held open for a moment is still removed
- [x] A merge that succeeded but whose cleanup failed still moves the Item on, or asks the person, and never leaves it stuck
- [x] Approving a Gate whose branch is already merged finishes the cleanup and advances, instead of raising the review Ask again
