# 04: The effective Workflow: module Stages and command Exit checks

**What to build:** When a Project's files load, compute its **effective Workflow**: the Project's Workflow (the default or `.kiln/workflow.json`), with each module's `stages` inserted in module order and its `exitChecks` applied (beside a check, or `replaces` it). The existing validator checks the result. A module that makes it invalid is a Project error, and the Project keeps its last valid Workflow.

Exit checks gain a command kind, `module:<module>/<check>`. It runs the command in the Item's worktree, the same way `tests_pass` runs `testCommand`; a non-zero exit fails it, and its output goes in the Thread. Module Stages without a role (such as "Print it") are the person's move. User stories 13 and 14 in `spec.md`.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The effective Workflow is a pure function, with tests: Stages inserted in order, a check added, a check replacing `tests_pass`, an invalid result reported as a Project error
- [ ] A command Exit check passes and fails on small scripts in a temp worktree, and its output reaches the Thread
- [ ] A Project with no modules gets exactly its old Workflow
