---
title: Kiln merges into, and branches from, the Project's real trunk
epic: projects-and-onboarding
stage: grill
blocked-by: []
---
`defaultBranch()` in `packages/core/src/flow/git.ts` takes `origin/HEAD`, else a local `main` or `master`, else whatever is checked out. In the Kiln repo the person worked on `demo-project` while a stale local `master` sat 89 commits behind. So every Gate approval failed ("The Project's checkout is on demo-project, not master; Kiln merges only into master", `packages/core/src/flow/gates.ts:167`), and every Story branch forked from the stale `master`, so its Agents worked on old code without anyone noticing. The only sign was a line added to the Ask's "why", and the approve button looked like it did nothing.

## To grill

- Where the trunk comes from: a `trunk` Project setting (set in the wizard, shown in Settings), the checked-out branch, or `origin/HEAD` / main / master as now, and in what order?
- When the checkout is not on the trunk: refuse to start a Stage (so nothing forks from old code), offer to switch, or merge into the checked-out branch?
- A Story branch that forked from a commit far behind the trunk: warn on the card, or rebase before the next Stage starts?
- The failed approval: a Needs-you entry that says what to do, rather than a line added to the old Ask.
