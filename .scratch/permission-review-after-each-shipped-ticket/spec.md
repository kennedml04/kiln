# Spec: Permission review after each shipped Ticket

From `story.md` and `grill.md` (grilled 2026-11-06). Status: ready-for-agent.

## Problem

The owner loses hours waiting on Permission Asks they always allow. On 2026-11-06, between 14:34 and 18:10 UTC, there were 39 Permission Asks: median wait 10 minutes, p90 59 minutes, 14.3 Session-hours blocked. 33 were Allow once, 5 Always allow, 0 Deny. Every one was allowed, so the waiting bought nothing. One allowed command, `taskkill //F //IM node.exe`, killed the Kiln core and every running Session.

## What is already on the trunk (not reworked)

- `packages/core/src/policy/permission-review.ts`: on `item.merged` / `item.pr_merged` it collects the Item's answered Permission Asks since its last review and groups them with `groupByRule`. It raises one non-blocking Decision Ask (Apply all / Apply some + numbers in the comment / Skip all) and commits the chosen rules with `policy.addRules` as one Policy commit. It warns about kills by image name.
- `packages/widget-sdk/src/rule-patterns.ts`: `rulePattern` (prefix rules such as `git checkout -q *`, never a local folder: `LOCAL_PATH`), `alwaysAllowMatch`, `killsByName`, `groupByRule`.
- The Session's own Claude Code folder (`ownFolderOf`, from the hook's `transcript_path`) is already a read root in `widgets/claude-code/src/permissions.ts` (commit f07e4a3).

This story fills four gaps. Each one is a Ticket of its own and can ship alone.

## 1. Kill-by-name is a hard Deny built into Kiln

**Behaviour**

- Any permission request whose detail satisfies `killsByName` is denied at once, with no Ask, whatever the Org, Project or Stage layers say and whatever rules exist (an `allow` rule for `taskkill *` doesn't loosen it). That covers `taskkill /IM` (any spelling: `/IM`, `//IM`, `-im`), `pkill`, `killall`, `Stop-Process -Name` / `spps` without `-Id`, `Get-Process … | Stop-Process`, `pgrep … | xargs kill`, `kill $(pgrep …)` / `` kill `pidof …` ``.
- Killing by PID (`taskkill /PID 1234`, `kill 1234`, `Stop-Process -Id 1234`) is unchanged: the Policy decides it, so usually an Ask.
- The Session is told why, in a `session.message` from Kiln, like the Co-Authored-By refusal: Kiln refused that command because it kills processes by image name, which can stop other Sessions and Kiln itself; kill only processes you started, by PID.
- It is audited as `permission.deny`, actor Kiln, outcome `refused`, with `by: 'kill_by_name'`.

**Where**

- In the core, in `onPermissionRequest` (`packages/core/src/flow/session-manager.ts`), beside the `CO_AUTHORED_BY` check and before `decide`. So every Agent Widget gets it, not only Claude Code, and chats and Project Threads too.
- "Always allow" is never offered for such a request (it never reaches an Ask). The Policy page and `decide` itself are unchanged: the hard Deny is a core refusal, not a Policy rule. If a Project's policy.json has an allow rule that only matches kills by name, the review's existing warning ("is allowed by a Policy rule") stays.

**The review keeps its warning.** When a Session tried a kill by name, the review still lists it. After this Ticket those attempts are refused, so the review also reads `permission.deny` audit entries with `by: 'kill_by_name'` for the Item since its last review and warns: `"<command>" was refused: it kills processes by image name…`. Like any warning, this doesn't raise a review Ask on its own (see 2).

**Tests** (`packages/core/test/`, through `startTestKiln` + the fake Agent):

- A Project policy.json that allows `other_commands` and has an allow rule `taskkill *`: the fake Agent asks for `taskkill //F //IM node.exe` and is denied at once; no Ask is raised; the audit has the deny with `by: 'kill_by_name'`; the Session gets the message.
- Same for `pkill node`, `Stop-Process -Name node`, `Get-Process node | Stop-Process`, `kill $(pgrep node)`.
- `taskkill /PID 1234` and `kill 1234` still follow the Policy (Ask under the default Policy, allowed under an allow rule).
- In a Project Thread / chat Session too.

## 2. Minutes blocked, and Asks no rule can fix

**Minutes blocked.** For a group of Asks, minutes blocked is the sum of `answeredAt − raisedAt` over its Asks, rounded to whole minutes (under one minute shows as `<1 min`). Each listed group reads `N Asks, M min blocked`. The review's text opens with the Ticket's total over all the Asks it looked at: `39 Permission Asks on this Ticket, 858 min blocked.`

**Info-only groups.** Answered Permission Asks that no rule can fix are listed for information, with count and minutes blocked and no number (so no Apply). That is every answered Permission Ask the review looked at that isn't covered by a proposed rule or fold, for one of these reasons:

- `alwaysAllowMatch` is undefined: the only rule would name a local folder (reads outside the worktree, `rm` of a path under a home folder, …).
- `rulePattern` is undefined and the request came once (a one-off `rm`, a `NO_PATTERN` program).
- The Org or Stage layer stands in the way (`alwaysAllowOffered` is false).
- The command kills by name.
- It was denied at least once (not always allowed).

Info groups are grouped by the same key as `groupByRule` when there is one; requests with no match are grouped by action plus program (the first word of the command, or the action alone for non-command actions such as `outside_worktree`), shown with up to 3 examples. Local folder paths in examples are fine here: the text is an Ask on this machine, never written into the Policy. Each info line says why there is no rule, in a few words (`names a local folder`, `one-off`, `the Org Policy asks`, `kills by name`, `was denied`).

**Order.** Proposed rules and folds come first, numbered, sorted by minutes blocked (most first); ties by Ask count, then by match. Info groups follow under a heading `No rule can fix these:`, sorted the same way. Warnings come last.

**When an Ask is raised.** The review Ask is raised only when there is at least one rule or fold to apply. Info groups and warnings never raise one on their own; they ride along when one is raised. (So the "since its last review" window keeps them until the next review that does raise an Ask.)

**Data.** `PermissionReview` (widget-sdk) gains `minutes` per `ProposedRule`, a total (`asks`, `minutes`), and `info: { action, label, reason, asks, minutes, examples }[]`. `askIds` keeps every Ask looked at. The Shell shows the review's text as it does today (the `why`); no new Shell view is needed.

**Tests:** a merged Item with Asks of known `raisedAt`/`answeredAt` (answered at controlled times through the API) shows the total, per-group minutes, the sort order, and the info lines with their reasons; an Item whose Asks are all info-only raises no review Ask.

## 3. Fold literal rules into patterns

Each review also looks at the Project layer's allow rules (`policy.projectLayer(project).rules`, decision `allow`, never Org or Stage rules). Where two or more rules of one action have the same `rulePattern(action, rule.match)`, and that pattern differs from each of them, it proposes a fold: "replace these N rules with one pattern".

- Example: `git log --oneline -5`, `git log --oneline -8`, `git log --oneline -12` → `git log --oneline *`.
- A rule that already ends in ` *` takes part only when its pattern is a different, wider rule (it never is today, because `rulePattern` keeps the flags; so in practice only literal rules fold).
- No fold when `rulePattern` is undefined for any of them (NO_PATTERN programs, forcing flags, `git reset`, `gh api`, …), when the pattern names a local folder, when the pattern would match a kill by name, or when `alwaysAllowOffered` is false for any of the literals.
- If the pattern is already an allow rule in the Project layer, the fold just removes the literals it covers ("remove N rules the pattern `…` already covers").
- Literals no pattern covers are never deleted. A literal with no sibling (one rule alone for its pattern) is left as it is.
- If a new rule proposed by this same review has the same action and match as a fold's pattern, the two are one numbered item (the fold, which also counts the Asks and minutes of the new rule).

**In the Ask.** Folds are numbered items in the same list as new rules, in the same single Ask, with the same Apply all / Apply some / Skip all. A fold line reads: `3. git log --oneline * (other_commands, replaces 3 rules: git log --oneline -5, -8, -12)`. Folds have no minutes blocked of their own (they block nothing now) and sort after new rules, by the number of rules replaced. The question counts both: `Save 2 Policy rules and fold 1 set of rules for the Permission Asks on "…"?`

**Applying.** Applying any mix of new rules and folds is one Policy commit of `.kiln/policy.json`, as Kiln: the chosen literals are removed and the chosen patterns added. `PolicyEngine` gets `changeRules(project, { add, remove }, message)` (or `addRules` takes an optional `remove`), with the same 409 when the file has uncommitted changes, rules matched by action + match + decision `allow`. The commit message names both: `Kiln: Permission review allows 2 command shapes and folds 3 rules into 1`. The audit entry's `detail` lists `applied` and `folded: [{ action, match, replaced: string[] }]`.

**When the review runs.** A fold alone is enough to raise the review Ask, but only on a merge whose review would look at at least one answered Permission Ask (the review stays a look back at a shipped Ticket, not a Policy linter on every merge).

**Not proposed again after a Skip.** A fold that was offered and not applied (Skip all, or left out of Apply some) is not proposed again until the set of literals it would replace has grown. The review finds earlier offers in earlier `permission_review` Asks' `permissionReview` data in the same Project (any Item) and compares: same action and pattern, and the current literal set is a subset of one already offered → skip it. A review Ask that is still open counts as offered.

**Tests:** three literals plus one new matching Ask → one fold item; Apply all leaves one pattern and no literals, in one commit touching only `.kiln/policy.json`; Apply some with only the new rules leaves the literals; a skipped fold isn't offered on the next merge, and is once a fourth literal is added; `rm` / `git reset` literals never fold; a literal alone is never removed.

## 4. Claude Code's tool-results folder is a read root

Claude Code saves long tool results under its projects folder (`<config>/projects/<slug>/<session id>/tool-results/…`, where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`) and tells the Session to read them back. The Session's own folder is a read root already, but on 2026-11-06 after that shipped there were still Asks to read a tool-results file outside the worktree.

- First, reproduce why: likely cases are a hook without `transcript_path`, a subagent whose transcript lives elsewhere, or a path spelled another way (Git Bash `/c/Users/…`, different case). Fix the cause if it's in `ownFolderOf` or path matching.
- Then make every `tool-results` folder under `<config>/projects/` a read root in the Claude Code Agent Widget, like the temp folder but read-only: read tools (Read, Grep, Glob, …) and read-only shell commands (`cat`, `head`, `grep`, `wc`, … as the shell Policy judges reads) under it are `worktree_read`; writes there stay `outside_worktree`. Only folders named exactly `tool-results` count, not the transcripts beside them.
- A Stage that denies `outside_worktree` (chat, Project Thread) still gets the Session's own folder only, as today; this read root follows the same rule as `SCRATCH`.
- The folder is computed on the machine at run time and is never written into a rule or a commit.

**Tests** (`widgets/claude-code/test/`): `requestFor` with a Read of `<config>/projects/x/y/tool-results/abc.txt` and no `ownFolder` is `worktree_read`; a Bash `cat` / `head -50` of it is a read; a Write there is `outside_worktree`; a Read of `<config>/projects/x/y.jsonl` is still `outside_worktree`; Windows, Git Bash and posix spellings; `CLAUDE_CONFIG_DIR` set.

## Rules for every Ticket

- No rule or fold ever names a local folder (`LOCAL_PATH`); publishing refuses them.
- Nothing changes the Policy without a person's answer, except the hard Deny, which isn't a Policy change.
- Tests drive Kiln from outside (`startTestKiln`, the fake Agent, the HTTP API); no asserting on internal modules or tables.

## Out of scope

- Which read-only commands the shell Policy treats as reads (the shell-commands work).
- `core.stop` waiting on Sessions that wait on Asks (restart-when-idle). Fewer Asks helps; changing it is not this story.
- A Shell view of review statistics beyond the Ask's text.

## Suggested Tickets

1. Hard Deny on kill-by-name (section 1).
2. Minutes blocked and info-only groups (section 2).
3. Fold literal rules into patterns (section 3; after 2, since it uses the same ordering and data).
4. Tool-results read root (section 4).
