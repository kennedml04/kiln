# Review: 01 Linked Projects in one Session

Branch `kiln/ticket/linked-projects/01`, commits 9f3cec6, b8d9853, 7ef777f, compared with 76e9ec3.

## Verdict

**Approve with follow-ups.** All five acceptance criteria are met, and `linked-projects.test.ts` covers them (2/2 pass in this worktree after `npm ci`). Two findings below (F1, F2) are real gaps that the later slices don't obviously cover. They should get Tickets, but they don't block this slice.

## Acceptance criteria

| Criterion | Met? | Where |
|---|---|---|
| A client Item's Session gets a worktree of the client and each linked Project, side by side, on one branch name | Yes | `linked.ts` `setupLinked`; the task folder `<data>/worktrees/<client id>/<key>/{<client>,<link>}`, all on `kiln/<key>`; the Agent's cwd is the task folder (`session-manager.ts` `worktree: scratch ?? linked?.folder ?? worktree`). The second test commits in `lib/` on the branch. |
| A monorepo Item's Session opens only the monorepo | Yes, by construction | `worktreePath` and `start()` only branch on a non-empty `linkedProjects`. No test asserts this directly, but the existing suite covers the unlinked path. |
| The link command runs in the client worktree after the worktrees are made | Yes | `setupLinked` runs the link commands after every `ensureWorktree`. The test logs the cwd and asserts it ends in `client`. |
| A repo the Session didn't touch is dropped: no branch | Yes | `cleanupLinked` runs `branch -D` when a linked repo has no commits past its base and no changes. Tested. (Review and landing don't exist yet, so "no review, no landing" holds trivially for now.) |
| Ending the Session cleans up every worktree it made | Yes, with caveats (F3) | `end()` calls `cleanupLinked`. Worktrees with uncommitted non-linkFiles changes are kept on purpose. |

## Findings

### F1 (medium): a client Story's Tickets disappear from the board between its Session ending and its Gate merge
`work.ts` `records()` reads the child records a live Session wrote from `run.worktree` and skips it when `!existsSync(run.worktree)`. Before this change the worktree was "kept across its Stages until it merges". Now, for a client Project, `end()` removes the client worktree as soon as the Session finishes, which is before `gates.raise`. So a Story on a client Project that slices into Tickets shows no Tickets while it sits at its Review Gate. The Gate's own artifacts still work because `gates.ts` reads with `fileAtHead(project.path, path, branch)`, from the branch. The test doesn't cover Story Items.
Fix options: read child records from the branch (`git show`/`ls-tree` on `kiln/<key>`) rather than the worktree, or keep the client worktree until merge and only clean up the linked worktrees at Session end. The ticket says "every worktree", so the first option fits the spec better.

### F2 (medium): the one branch name can collide with the linked Project's own Items or another client's
Every linked repo gets branch `kiln/<item key>`, and keys are tracker paths like `ticket/<feature>/01`. If the monorepo has its own Item with the same key, or two client Projects with the same key link the same monorepo:
- while the other Item's worktree exists, `git worktree add` fails because the branch is already checked out. That is a plain git error, so start fails with a 500 instead of a clear 409;
- once that worktree is gone but its branch is still there with commits, the client Session checks out **the other Item's branch** and commits onto it. Cleanup sees commits past base and keeps it. The other Item's Gate then merges the client Session's monorepo work (and slice 3's landing would mix the two).
Feature slugs can collide across Projects. Suggest namespacing the branch in linked repos (for example by the client Project) or refusing to start when the branch belongs to an Item of the linked Project. Ticket 06 (overlap marker) assumes concurrent client Items on the same linked Project, which makes this more likely.

### F3 (low): cleanup races the still-running Agent and slows the Gate
`end()` runs `cleanupLinked` while a finished Session's Agent process is still alive (it is only stopped later by `releaseItem`), and the Agent's cwd is the task folder. On Windows the task folder can't be removed then, and child processes in a worktree make `removeWorktree` retry for about 7s per repo before it gives up silently. `onFinished` awaits `end()` before `gates.raise`, so a person's Review Ask can arrive 10s+ late, and leftovers wait for the merge-time `removeTaskFolder`, which only removes an *empty* folder. A kept or leftover linked worktree therefore keeps the task folder for good. Consider stopping the Agent (as `releaseItem` does) before cleanup for linked Sessions, and running cleanup without blocking the Gate.

### F4 (low): resume guard is in-memory only
`message()` skips resume via `!last.linked`. `linked` exists only on the `Live` object made in `start()`, so any `Live` rebuilt some other way would resume into a deleted folder. No such path exists today (I found no other `live.set`), so this is a note for whoever adds session restore after a restart.

### F5 (low): smaller points
- `cleanupLinked` parses porcelain with `line.slice(3)`, so a linkFile with spaces (quoted by git) or a rename (`a -> b`) won't match. That's fine for `package.json` and `pnpm-lock.yaml`.
- The link command runs through the shell outside Policy. That's acceptable until slice 05, which should list it.
- `linkFiles` from every link is applied to every repo's dirty check, linked repos included. That's harmless but not exactly what was meant.
- The test asserts `ran[0]` matches `/[\\/]kiln[\\/]|ticket/i`, which is a weak check. A link command that checks `../lib` exists would prove the "side by side, before the link" order directly.

## Carried forward (already in the implementer's Digest; these belong to later slices)
- A link that edits tracked files (pnpm link → `package.json`) leaves the client tree dirty, so a `tree_clean` Exit would fail, and an Agent doing `git add -A` would commit the link. This is slice 02's linkFiles check.
- Paused or Stop-all Sessions keep their worktrees until they end.

## Tests
- `node --test packages/core/test/linked-projects.test.ts`: 2/2 pass.
- Full `npm test`: see the Digest for the result of the run made during this review.
