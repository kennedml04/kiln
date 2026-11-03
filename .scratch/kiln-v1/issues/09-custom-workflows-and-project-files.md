# 09: Custom Workflows and Project files

**What to build:** A Project can define its own Workflow in the repo's `.kiln` folder, next to its Project settings: test command, known commands, local-only flag, merge or PR mode, and Tracker choice. A Workflow lists Item kinds and, for each kind, its ordered Stages. Each Stage names its agent role, Agent, model, optional fallback model, Exit (combined from the fixed set of named checks), whether it is a Gate, whether it needs a worktree, its Stage Policy and its capacity pool. Kiln validates the Workflow and shows clear errors in the Shell. A Project with no Workflow file uses the default. Every Stage must name its model, so the expensive model is never the silent default. Changing the Workflow file updates the Project's board live.

**Blocked by:** 08

**Status:** resolved

- [ ] A custom Workflow with its own Item kinds, Stages and Gates drives the Project's board and the Item moves
- [ ] An invalid Workflow is rejected with errors that point at the problem, and the Project keeps its last valid Workflow
- [ ] A Stage with no model is a validation error
- [ ] The Project settings (test command, known commands, local-only, merge or PR mode, Tracker) are read from the `.kiln` folder
- [ ] Editing the Workflow file updates the Project view live
