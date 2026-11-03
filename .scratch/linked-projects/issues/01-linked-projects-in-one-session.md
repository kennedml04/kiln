# 01: Linked Projects in one Session

**What to build:** Let one Session work across linked Projects at once. The case: a client app that wraps and consumes a monorepo, where a change in the client sometimes needs a native change in the monorepo too. Today each Session gets one worktree in one Project, so the Agent can't see or edit the other repo. Work done only in the monorepo must keep working exactly as it does today.

Decisions (grilled 2026-11-03):

1. **The link.** A link lives on the Project and points one way: the client Project declares that it consumes the monorepo Project. Both stay full, normal Projects. Starting a monorepo Item opens only the monorepo, the same as an unlinked Project today.
2. **Worktrees.** Every Session on a client Item gets a task folder with a worktree of each linked repo side by side, all on one branch name, and the Session starts in that folder. When the Session ends, any repo it didn't touch is dropped: no branch, no review, no landing. A client Item that touched only the monorepo lands only the monorepo. Ending the Session cleans up every worktree it made.
3. **Where the Item lives.** The Item has one home: the Project it was made in, with its tracker and board. While the Item has an open branch in a linked Project, that Project's board shows a read-only "linked work" card for it. Nothing is mirrored into the other tracker.
4. **Linking during a Session.** The client's Project settings declare, for each linked Project, a link command and the files that command changes, for example `"linkedProjects": { "monorepo": { "link": "pnpm link ../monorepo", "linkFiles": ["package.json", "pnpm-lock.yaml"] } }`. Kiln runs the link command in the client worktree after making the worktrees. If any of the link's changes show up in the client's diff, the Exit fails with a plain message, so a local link never reaches a commit or a PR.
5. **The Exit check.** If the monorepo changed, its own `testCommand` runs in its worktree. The client's `testCommand` always runs in the client worktree, linked to the sibling monorepo worktree. The Exit is met only when all of them pass, and the feedback names which repo failed.
6. **Review and landing.** One Review Ask shows the diffs from both repos together. Once it's approved, each repo lands by its own Project's merge mode (local merge or PR mode) and that Project's Policy. Kiln never pushes or merges in a repo beyond what that Project would do for its own Items. The monorepo lands first, because the client consumes it.
7. **A landing that fails partway.** If the monorepo lands and the client then fails to, nothing is rolled back. The Item goes back for rework with a plain note: "monorepo changes landed on `<branch/PR>`; the client side didn't: `<reason>`". The rework Session reopens both worktrees, with the monorepo based on its updated main, and afterwards only the client lands.
8. **Policy.** File edits and commands inside a repo's worktree follow that repo's Project Policy. An action Kiln can't attribute to one repo, such as a command run from the task folder root or one that names paths in both, gets the stricter of the two Policies for that action: deny beats ask, and ask beats allow.
9. **Usage.** A linked Session's usage counts only against its home Item, Epic and Project, and its model's Budget, the same as today. The "linked work" card shows no cost.
10. **Concurrency.** There's no locking. Two client Items may change the monorepo at once, each on its own branch. The monorepo board shows a "linked work" card for each one. A client Item's card shows a marker when another open Item also touches the same linked Project. Whichever lands second goes through the normal conflict handling: a conflicting monorepo merge sends the Item back for rework.

Out of scope for now: an optional per-link setting, "also check consumers", where a monorepo Item runs each consumer's tests against it. The consumer repos would be test-only: no edits, no landing.

**Blocked by:** None. It builds on Sessions, Exits, the Review gate, PR mode and the Policy from kiln-v1.

**Status:** ready-for-agent

- [ ] A Session on a client Item gets a worktree of the client and of each linked Project, side by side, on one branch name
- [ ] A monorepo Item's Session opens only the monorepo
- [ ] The link command runs in the client worktree, and the Exit fails if any of the link's changes are in the client's diff
- [ ] The Exit runs each touched repo's tests and the client's tests against the linked monorepo, and is met only when all of them pass
- [ ] One Review Ask shows both diffs. On approval each repo lands by its own merge mode and Policy, monorepo first, and an untouched repo isn't landed
- [ ] When the monorepo lands and the client fails to, the Item goes back for rework with a note, and the monorepo is not rolled back
- [ ] Actions follow the Policy of the repo they happen in, and the stricter Policy for actions Kiln can't attribute to one repo
- [ ] The linked Project's board shows a read-only "linked work" card while a branch is open, with an overlap marker when two Items touch it
- [ ] Usage counts only against the home Item, Epic and Project
- [ ] Ending the Session cleans up every worktree it made
