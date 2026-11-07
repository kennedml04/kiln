# 01: Linked Projects in one Session

**What to build:** The first slice of Linked Projects: the link on a Project, and a client Item's Session getting side-by-side worktrees of the client and each linked Project on one branch name, starting in a task folder. A monorepo Item's Session still opens only the monorepo. Ending the Session cleans up every worktree it made, and a repo the Session never touched is dropped (no branch, no review, no landing).

The link lives on the client Project and points one way: the client declares that it consumes the monorepo Project. Both stay full, normal Projects. Settings: `"linkedProjects": { "monorepo": { "link": "pnpm link ../monorepo", "linkFiles": ["package.json", "pnpm-lock.yaml"] } }`. Kiln runs the link command in the client worktree after making the worktrees.

Later slices (separate tickets) cover the Exit checks, review and landing, partial-landing rework, Policy, and the "linked work" card.

**Blocked by:** None.

**Status:** done

**Stage:** shipped

- [ ] A Session on a client Item gets a worktree of the client and of each linked Project, side by side, on one branch name
- [ ] A monorepo Item's Session opens only the monorepo, as today
- [ ] The link command runs in the client worktree after the worktrees are made
- [ ] A repo the Session didn't touch is dropped when it ends: no branch, no review, no landing
- [ ] Ending the Session cleans up every worktree it made
