---
title: Messy demo scenarios and real-repo copies
epic: projects-and-onboarding
stage: roadmap
blocked-by: [demo-project]
---
The clean demo Project (`.scratch/demo-project/story.md`) proves the workflow but hides the problems that break real runs. Two additions, both on dev instances only. First, mess scenarios on the demo repo, each one switchable, that recreate failures the old board actually hit: main moves during a Ticket so the merge conflicts; a slow test suite and a flaky test; a test already failing on main before the Ticket starts; uncommitted work by someone else in the checkout; a large diff for Review; a step that needs a permission Ask (`gh pr create`, killing a process); a Session long enough to trip the context alarm or a Budget cap; an Agent that stalls. Each scenario says what Kiln should do (raise an Ask, pause, route to rework) and doubles as a regression test. Second, a "copy of a real Project" mode: clone a real repo into the dev data folder with its push remote removed, so real size, real tests and real history can be tried with no way to touch the original. Needs a grill first.

## Questions for the grill

- Which scenarios come first. A suggested order, by how often they hurt the old board: merge conflict, someone else's uncommitted work, permission Ask, failing test on main, then the rest.
- How a scenario is turned on: a dev-wizard checkbox, a flag on `kiln dev`, or a file in the demo repo.
- Whether scenarios are scripted on the fake test Agent (repeatable, free) or run with real models (realistic, costs Budget), or both.
- For real-repo copies: `git clone --local` vs `--no-hardlinks`, how the push remote is removed and checked (the copy must fail to push), and whether git hooks and CI config are kept.
- Whether real-repo copies skip anything private (gitignored data, secrets in `.env`) and how that is verified.
- What counts as passing for each scenario, so they can run unattended as a suite.
