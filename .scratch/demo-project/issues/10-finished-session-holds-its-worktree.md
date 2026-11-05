# 10: A finished Session's Claude Code process holds its worktree

**What to build:** Found in the first Live run (09). The griller Session finished and met its Exit, but its `claude.exe` (a child of the Claude Code Widget) kept running with its working folder inside the Story's worktree. On Windows a process's working folder can't be deleted, so `mergeOnExit` merged the branch and then failed on `git worktree remove --force` ("Permission denied"). The Item stayed at Grill with only a Thread message, "Kiln could not finish the Stage: …". Nothing retried it, and moving the card by hand is refused (correctly), so the person is stuck. Fixed by hand by stopping the process, removing the worktree and setting the stage in `story.md`.

The grill paused and resumed around its blocking Asks ("Agent finished (interrupted)" then "(completed)"), so a resumed Session may leave the first `claude.exe` behind.

Three parts:
1. The Claude Code Agent ends its `claude.exe` when a Session finishes (closes the SDK query and waits for the process to exit), including any process an interrupt left behind.
2. `removeWorktree` (`packages/core/src/flow/git.ts`) retries a few times on Windows "Permission denied" before failing.
3. A Stage finish that fails after the merge doesn't strand the Item. The core finishes what's left (cleanup, advance) on a retry or at the next start, or it raises a blocking Ask with a Retry.

**Blocked by:** None

**Status:** needs-triage

- [ ] No `claude.exe` is left running in a worktree after its Session finishes, interrupted-and-resumed Sessions included
- [ ] A worktree held open for a moment is still removed
- [ ] A merge that succeeded but whose cleanup failed still moves the Item on, or asks the person, and never leaves it stuck
