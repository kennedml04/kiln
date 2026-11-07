# Grill: Kiln merges into, and branches from, the Project's real trunk

All four open questions were settled through Asks with the person. Each answer was the recommended option.

## 1. Where the trunk comes from

**Decided:** each Project stores a `trunk` setting. Once it is set, Kiln never guesses the trunk again.

- The wizard proposes the checked-out branch, and names `origin/HEAD` beside it when the two differ. The person confirms the choice.
- Settings shows the trunk and lets the person change it.
- Registration checks that the checkout is on the confirmed trunk, not on the guess. This replaces the `off-default-branch` check in `packages/core/src/work/repo-check.ts`.
- An existing Project with no trunk gets one blocking Needs-you Ask to confirm it, prefilled the same way. No Stage starts and no Gate merges for that Project until the person answers.
- `defaultBranch()` (`packages/core/src/flow/git.ts`) stays only as the source of the wizard's proposal. Every caller that needs the branch Kiln merges into reads the setting: `session-manager.ts`, `gates.ts`, `markdown-tracker.ts` and `import-scan.ts`.

## 2. When the main checkout is not on the trunk

**Decided:**

- Stages start whatever branch the checkout is on. Story worktrees fork from the trunk ref (`git worktree add -b kiln/<key> <path> <trunk>`), not from the checkout.
- A Gate merge, and a markdown Tracker Stage/Status commit, goes into the trunk:
  - When the main checkout is on the trunk, it happens there, as today.
  - Otherwise it happens in a short-lived Kiln worktree of the trunk, so the person's checkout and branch are never touched.
- Kiln never switches branches and never merges into a branch other than the trunk.
- If the trunk is checked out in a worktree Kiln doesn't own, the merge stops with a Needs-you entry saying so (see 4).

## 3. A Story branch that is behind the trunk

**Decided:**

- Before each Stage starts in an existing worktree, Kiln merges the trunk into the Story branch if the branch is behind and the worktree is clean. This is a Kiln-authored merge, not a rebase.
- If the merge would conflict, Kiln leaves the branch as it was and starts nothing. It raises a blocking Needs-you Decision that names the conflicting files, with two options:
  - "Start the Stage and have its Agent resolve the conflict" (recommended).
  - "I'll fix it myself".
- Whenever a Story's branch is behind the trunk, the card shows "N behind trunk", so a stale branch is never silent.

## 4. A Gate approval Kiln can't act on

**Decided:**

- The approval stands. The Review Ask is resolved as approved and is no longer re-raised with "Kiln could not act on the last answer" appended to its why (`gates.ts` `deliver` catch).
- Kiln raises a new blocking Decision in Needs you on the Item, headed "Approved, but Kiln couldn't merge <Story> into <trunk>".
  - Its why gives the cause in plain words and the exact fix, for example "commit or stash the changes in <file>" or "<trunk> is checked out in <path>".
  - Its options are "Try the merge again" (recommended) and "Send it back to rework".
- "Try the merge again" reruns only the merge.
- The Shell also shows a toast on the failure, so the approve click visibly did something.

## Still open, for the spec

- What a trunk-worktree merge does when the trunk ref moves on in the person's checkout during the merge. Probably: re-check that the ref is unchanged before updating it, else retry.
- Whether an uncommitted Story worktree skips the catch-up merge silently (the "N behind" badge still shows) or asks.
- How a PR-mode Project uses `trunk`: it is the PR base, and should stay in step with `github.remote`'s default branch.
