# 02: Exit checks for linked Projects

**What to build:** On a client Item's Exit: if the monorepo changed, run its testCommand in its worktree; always run the client's testCommand in the client worktree linked to the sibling monorepo worktree. Fail the Exit if any of the link command's linkFiles changes appear in the client's diff, so a local link never reaches a commit or PR. Met only when all pass; feedback names which repo failed. Blocked by 01.

**Blocked by:** None

**Status:** needs-triage
