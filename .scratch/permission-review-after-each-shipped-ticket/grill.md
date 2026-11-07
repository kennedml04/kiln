# Grill: Permission review after each shipped Ticket

Grilled 2026-11-06.

## Where things stand

Most of the story is already on the trunk (commit 2822b6a, "Permission review: one Decision Ask after a merge proposes Policy rules", and 39464f4, "Always allow saves a prefix rule, never a local folder"):

- `packages/core/src/policy/permission-review.ts`: on `item.merged` / `item.pr_merged`, it collects the Item's answered Permission Asks since its last review and groups them by `groupByRule`. It raises one non-blocking Decision Ask (Apply all / Apply some + numbers in the comment / Skip all) and commits the chosen rules with `policy.addRules` as a single Policy commit. Nothing changes until someone answers.
- `packages/widget-sdk/src/rule-patterns.ts`: `rulePattern` turns a command into a prefix rule (`git checkout -q *`) and never writes a local folder path into a rule (`LOCAL_PATH`). `killsByName` spots kills by image name. The review already warns about those.
- Tested in `packages/core/test/permission-review.test.ts`.

## Decisions

1. **Scope: only the gaps.** This story builds on the existing review and does not rework it. (Owner's answer.)
2. **Kill-by-name becomes a hard Deny built into Kiln**, not a rule in a Project's policy.json, and the warning stays. Any command where `killsByName` is true is denied with no Ask, whatever the org, Project or Stage layers say: `taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name` / `Get-Process | Stop-Process`, `kill $(pgrep …)`. Killing by PID is unchanged (still decided by the Policy, so usually an Ask). The deny reason tells the Agent to kill only processes it started, by PID. The review still lists the warning when a Session tried one. (Owner's answer.)
3. **Fold literal rules into patterns, in the same single Ask.** Each review also checks the Project's existing allow rules. Where two or more literal rules share one `rulePattern` (e.g. `git log --oneline -5`, `-8`, `-12` → `git log --oneline *`), it proposes "replace these N rules with one pattern" as a numbered item next to the new rules, with the same Apply all / Apply some / Skip all. Applying it removes the literals and adds the pattern in the same Policy commit. Literals that no pattern covers are never deleted. (Owner's answer.)
4. **Asks no rule can fix are listed for information.** Examples: reads outside the worktree, `rm`, anything whose only possible rule would name a local folder. These groups appear in the review's text with count and minutes blocked, but with no Apply option. (Owner's answer.)
5. **Claude Code's tool-results folder becomes a read root** in the Claude Code Agent Widget, like the temp folder. Reading those files no longer raises an Ask. (Owner's answer.)

## Defaults taken (not asked; change them in Slice if wrong)

- **Minutes blocked** for a group is the sum of `answeredAt − raisedAt` over its Asks. Every group, proposed or info-only, shows "N Asks, M min blocked". The review's text opens with the Ticket total.
- **Groups come first, sorted by minutes blocked**, so the costliest come first.
- **A fold that was skipped is not proposed again** until a new literal joins it (i.e. the set of literals it would replace has grown). Otherwise every merge would repeat it.
- **Info-only groups never raise an Ask on their own.** The review Ask is raised only when there is at least one rule or fold to apply. Info groups go along when it is.
- **No rule or fold is ever proposed if it names a local folder** (`LOCAL_PATH`), because publishing refuses them. A fold whose pattern would be refused by `rulePattern` (NO_PATTERN programs, forcing flags, `git reset`, …) is not proposed.
- **The hard Deny is checked before the Policy layers**, in the core's Policy decision, so every Agent Widget gets it, not only Claude Code. It is audited like any other deny.

## Out of scope

- Changing which read-only commands the shell Policy treats as reads (that is the shell-commands work).
- Restart-when-idle waiting on Asks. Fewer Asks helps, but changing `core.stop` is not this story.

## Open

- None blocking. Slice can split this into roughly four Tickets: hard Deny on kill-by-name; minutes blocked + info-only groups; folding literals; the tool-results read root.
