# Spec: "Always allow" must not write machine paths into the repo

Status: ready-for-agent

Blocked by: nothing.

Sources: `.scratch/policy-path-leak/story.md`, `.scratch/policy-path-leak/grill.md` (grill decisions of 2026-11-06, numbered 1–4 below as they are there), and the code as of branch `kiln/story/policy-path-leak` (af63ad0). The match "Always allow" saves comes from `alwaysAllowMatch` in `packages/widget-sdk/src/rule-patterns.ts`. The Session Manager offers and keeps the answer (`packages/core/src/flow/session-manager.ts`, the permission Ask and the `session` recipient's `prepare`). The Permission review proposes rules through `groupByRule` (same SDK file) and writes them through `policy.addRules` (`packages/core/src/policy/permission-review.ts`). The Policy engine's `addRules` and `alwaysAllow` are in `packages/core/src/policy/policy.ts`.

## Problem Statement

- "Always allow" on a request that names a machine path saves a rule that matches that path. The rule only ever matches that one folder, and it ends up in the Project's `.kiln/policy.json` and in the commit subject.
- A home-folder path is already refused (39464f4), but other absolute paths are not: `cd /tmp`, `cat > /tmp/fix.mjs <<'EOF'`, `D:/build/out`, `~/x`. Around 35 such rules are on the trunk now.
- Only the Session Manager and `groupByRule` check the match. `addRules` writes whatever it is given, so any other caller could still put a machine path in the file.
- The commit subject holds the whole match, however long or multi-line it is (`Kiln: always allow other_commands "cat > /tmp/x <<'EOF'\n..."`).

## Solution

"Always allow" is not offered when the match it would save names **any absolute path** (decision 1). Allow once and Deny are unchanged, and the request still runs on Allow once. The Permission review follows from the same check. The Policy engine's `addRules` refuses such a rule with a 409 before it writes or commits anything, as a backstop for every caller (decision 4). The commit subject keeps the match only when it is short and on one line; otherwise the match goes in the commit body (decision 3). A `cd` into the Session's own worktree already never asks; a regression test keeps it that way (decision 2).

## User Stories

1. As a Member, when a Session asks to run `cd /tmp`, `cat > /tmp/fix.mjs <<'EOF' ...`, `type D:\logs\out.txt` or `ls ~/x`, the Ask offers Allow once and Deny but not Always allow.
2. As a Member, Allow once on such an Ask lets the request run, as before.
3. As a Member, a request whose saved match drops the path (`git log C:/x` saves `git log *`) still offers Always allow, and the Ask still says which rule it saves.
4. As a Member, a request that only writes to `/dev/null` (`npm test 2>/dev/null`) still offers Always allow.
5. As a Member, a relative path (`cat a/b.txt`) or a URL or domain (`curl https://example.com/x`, judged by its own rules) is not counted as absolute.
6. As a Member, `cd` into the Session's own worktree, in any spelling (`C:\...`, `C:/...`, `/c/...`, quoted or not, followed by `&& ...`), never asks, even though that path is under a home folder.
7. As a Member, the Permission review never proposes a rule whose match names an absolute path; those Asks are left out of its groups, as home-folder ones are now.
8. As the owner, if anything asks the Policy engine to save a rule whose match names an absolute path (Always allow, the Permission review, or a later caller), it is refused with a 409 and nothing is written or committed. The other rules in the same request are not written either.
9. As the owner, an Always allow commit whose match is one line and makes a subject of at most 72 characters reads `Kiln: always allow other_commands "make *"`.
10. As the owner, any other Always allow commit has the subject `Kiln: always allow other_commands (a long rule)` and the full match in the commit body.
11. As the owner, rules already in `.kiln/policy.json` are not changed or deleted by this story.

## Implementation Decisions

### The absolute-path check (decision 1)

- Add one exported function in `packages/widget-sdk/src/rule-patterns.ts`, say `namesAbsolutePath(match: string): boolean`. It splits the match into words (on whitespace, and on the shell's `;`, `&`, `|`, `<`, `>`, `(`, `)`, `=`), strips surrounding quotes from each word, and is true when any word:
  - starts with a drive letter and a slash: `D:/`, `D:\` (any letter, either case);
  - starts with `/`, which covers the Git Bash drive (`/c/...`) and Unix paths (`/tmp/x`, `/etc`);
  - is `~` or starts with `~/` or `~\`.
- `/dev/null` (and words that start with `/dev/null`) are not counted.
- It also stays true whenever `LOCAL_PATH` matches, so nothing the current check refuses becomes allowed. A word the split misses (a home folder inside a longer word) is still caught that way.
- A word like `a/b`, `./x`, `../x`, `src\x`, or a URL (`https://...`: the word starts with the scheme, not `/`) is not absolute. An env-var path (`"$TEMP"/x`, `%TEMP%\x`) can't be resolved and is not counted.
- `alwaysAllowMatch` returns undefined when `namesAbsolutePath` is true for the match it would save, in place of the `LOCAL_PATH` test. `rulePattern` keeps its own `LOCAL_PATH` test as it is (its patterns drop arguments; the widened check applies to the saved match either way).
- Because `session-manager.ts` (offer and `prepare`) and `groupByRule` already go through `alwaysAllowMatch`, they need no change of their own.
- `LOCAL_PATH` stays exported. `scripts/publish.ts` keeps its own copy and its strip and rewrite for history, unchanged.

### `cd` into the own worktree (decision 2)

- Nothing to build. `shellRequest` reads `cd <worktree or a folder in it>` as `worktree_read`, which the Org default allows, so no Ask is raised and the new check is never reached. Only the regression test below is added.

### The backstop in `addRules` (decision 4)

- At the top of `addRules` in `packages/core/src/policy/policy.ts`, before `readFileLayer` and `commitOnly`: if any rule's match makes `namesAbsolutePath` true, throw `new WorkError(409, ...)` naming the action and saying the rule names a folder on this machine (do not repeat the path itself in the message). The whole call is refused; no partial write.
- `alwaysAllow` goes through `addRules`, so it is covered. The Permission review's route already turns a `WorkError` into its status.

### The commit message (decision 3)

- `alwaysAllow` builds the subject `Kiln: always allow ${action} ${JSON.stringify(match)}`. If the match has no line break and that subject is at most 72 characters, it is the whole message.
- Otherwise the subject is `Kiln: always allow ${action} (a long rule)` and the body, after a blank line, is the match as it stands (not JSON-quoted). `commitOnly` passes the message to `git commit -m` as now; a message with a blank line gives subject and body.
- The Permission review's subject (`Kiln: Permission review allows N command shapes`) is unchanged.

### Not changed

- Allow once, Deny, `alwaysAllowOffered`, the Org and Stage layers, and the Ask's wording other than which option is offered.
- `scripts/check-banned.ts` (it already scans `.kiln/policy.json`) and `scripts/publish.ts`.
- Existing rules in any Project's Policy file.
- No new check in Kiln's Exit.

## Testing Decisions

- Unit tests for `namesAbsolutePath` and `alwaysAllowMatch` in `packages/core/test/rule-patterns.test.ts` (where the SDK's rule-pattern tests already are), table-style:
  - absolute: `cd /tmp`, `cat > /tmp/fix.mjs <<'EOF'`, `type D:\logs\out.txt`, `type "d:/x y/z"`, `cd /c/work`, `ls ~/x`, `cd ~`, `echo hi>/tmp/x`, and the existing home-folder cases;
  - not absolute: `npm test 2>/dev/null`, `cat a/b.txt`, `node ./scripts/x.ts`, `cat ../x`, `curl https://example.com/a/b`, `cat "$TEMP"/x`, `make`;
  - `alwaysAllowMatch` still returns the prefix pattern for `git log C:/x` (`git log *`).
- `groupByRule` leaves out an Ask whose match names `/tmp/...`.
- Through `startTestKiln(t)` and `kiln.installFakeAgent`:
  - a scripted request `cat /tmp/x.txt` (an action the Policy asks about) raises an Ask without Always allow; answering Allow once lets it run;
  - answering Always allow on such an Ask by hand (the API) is refused with 409 and `.kiln/policy.json` in the temp repo is unchanged, with no new commit;
  - a scripted `cd "<the Session's worktree>" && git status`, with the worktree under a folder shaped like a home folder (`.../Users/<name>/...`), raises no Ask;
  - Always allow on a short command commits with the subject `Kiln: always allow <action> "<match>"`; on a long or multi-line one, the subject ends `(a long rule)` and the body holds the match (read with `git log -1 --format=%B` in the temp repo).
- The Permission review: posting a chosen rule whose match names `/tmp/x` is refused with 409 and nothing is committed.
- No assertions on internal modules or tables beyond the exported SDK functions; core behaviour is checked through the API and the temp repo's git history.

## Out of Scope

- Pruning the ~35 trunk rules that name `/tmp/...` or `~/...`; that's the person's call, and the Permission review is the natural place.
- A `{worktree}` placeholder or any other generalised match.
- Resolving env-var paths.
- The Policy file's growth to ~440 one-off rules.

## Further Notes

- A command saved as it stands with a URL in it is fine only because the URL word starts with a scheme; if a later rule pattern strips the scheme, revisit the check.
- The 72-character limit counts the whole subject, `Kiln: always allow ` included.
