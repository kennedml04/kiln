# Review: 03 One Review Ask and landing across linked repos

Commit reviewed: d7bcb33 (`gates.ts`, `git.ts`, `pull-requests.ts`, `asks.ts`, `NeedsYou.tsx`, `linked-projects.test.ts`).
`node --test packages/core/test/linked-projects.test.ts`: 4 pass, 0 fail.

## Verdict

The local-merge path meets the Ticket. There is one Review Ask with a diff per touched repo. Linked repos land first and the client last. Every local merge is conflict-checked before any of them lands, and an untouched repo is neither shown nor landed. Both of those paths have tests. The PR-mode and mixed paths have no tests, and they have one real bug (F1). Fix F1 and add a test for it before shipping. F2 to F4 are smaller.

## Findings

### F1 (major): a linked PR merged on GitHub gets pushed and proposed again

`gates.ts` `land` skips a PR-mode repo only when `pullRequests.openFor(item.id)` has an *open* record for it. `reposOf` still lists that repo after its PR merges on GitHub, because the local branch is not an ancestor of the local `main`, so `commitsAhead` is still above 0.

How it fails: the linked repo and the client are both in PR mode, and the Policy is `ask`.
1. Approve. The linked repo's Permission Ask is raised.
2. Answer "once". The linked PR opens, and `land` raises the client's Permission Ask.
3. The linked PR merges on GitHub. `onMerged` returns early because the client's Ask is open. That part is correct.
4. Answer the client's Ask. Its PR opens, and `land(item, ask)` runs again. The linked repo has no open record now, so `proposePullRequest` runs for it again: it pushes the branch again and opens a second PR, or raises another Permission Ask.

Fix: skip a repo that has any PR record for this Item and branch (open *or merged*), not only open ones. For example, add `forItem(itemId)` covering every state, or have `openFor` take a state.

### F2 (minor): linked worktree cleanup uses the Project's name, but setup uses the link's name

`setupLinked` puts each linked worktree at `join(folder, folderName(link.name))`. `link.name` is the key in the client's `linkedProjects` settings, which may be the Project's **id** or a differently-cased name. `land` removes `join(taskFolder, folderName(repo.project.name))`. When the key is an id, a linked worktree still on disk at landing (cleanupLinked leaves dirty ones behind) is not removed. Then `branch -d` fails because that worktree has the branch checked out, and the error is swallowed by `.catch`. The task folder stays because it is not empty. Fix: carry `link.name` (or the worktree path) on `Repo` from `linkedProjectsOf`, and use it in both places.

### F3 (minor): partial landing in the mixed modes is left in odd states (overlaps ticket 04)

- **Linked PR, client local:** the client merges locally in the same `land` call, then `land` returns because a PR is open. So `work.refresh(project.id)` and the `item.merged` event never happen for that local merge. `onMerged` later only advances the Item. `permission-review.ts` listens for `item.merged`, so it never sees this Item.
- **Linked PR closed without merging** (`onClosed`): the whole Item goes back to rework even when the client has already merged locally, or the client's PR is still open.
- **Linked local, client PR, Permission denied:** the re-raised Review Ask leaves the linked repo out, because it has already merged. If the person then rejects, the Item goes back with the linked repo already landed.

The Ticket says "monorepo first", and in PR mode "landing" the monorepo only opens its PR, so the client can merge before the monorepo change is actually on `main`. That is defensible, but the spec should say it explicitly. Ticket 04 can take the rest. Write it down there.

### F4 (minor): `mergeOnExit` now goes through `land`, so it can open PRs

Before this change, `mergeOnExit` always merged locally. Now it calls `land`, which uses `shipsByPullRequest(item, item.stage, …)`. On a PR-mode Project whose Exit-merging Stage is the last but one, it now opens a PR instead. This may well be right, but it is an unannounced behaviour change, and no test covers it.

### F5 (test gap)

No test covers a PR-mode linked repo, mixed local and PR landing, a `review.projectId` Permission Ask, or a conflict in the linked repo (the Decision Ask names the linked repo and nothing lands). The Ticket's "each by its own Project's merge mode (local merge or PR) and Policy" is the core of this slice. Add at least a mixed-mode test, and one covering F1.

### Nits

- In `land`, the checkout error still says "The Project's checkout is on …". For a linked repo it should name `repo.project.name`.
- `removeWorktree` uses `--force` on a linked worktree that still has uncommitted changes, so they are lost. The implementer's digest already notes this; the client has the same behaviour today.
- The Ticket file still says `Blocked by: None` while its text says "Blocked by 01".
