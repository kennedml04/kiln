---
title: "Always allow" must not write machine paths into the repo
epic: board-ux
stage: spec
blocked-by: []
---
"Always allow" on a command such as `cd "<a Session worktree>"` writes a rule into `.kiln/policy.json` that matches the absolute worktree path, and commits it with that path in the subject (`packages/core/src/policy/policy.ts:191`). The path names the person's home folder, so the tree and the message both fail `scripts/check-banned.ts` and `node scripts/publish.ts` refuses to publish. Every such answer also leaves a rule that only ever matches one Session's worktree.

## To grill

- Generalise the match (a worktree placeholder such as `{worktree}` that the Policy expands when it checks), or refuse "Always allow" on a request that names an absolute path outside the repo, or both?
- Should a plain `cd` into the Session's own worktree be allowed by default, so the Ask never comes up?
- The commit subject: name the action only and leave the match to the file?
- Clean-up: a check (in check-banned or Kiln's own Exit) that refuses a policy rule with a home-folder path before it is committed.
