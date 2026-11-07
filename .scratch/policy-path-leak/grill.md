# Grill: "Always allow" must not write machine paths into the repo

## What had already shipped when this was grilled

The story was filed on 2026-11-05. Most of it was fixed the next day, in other commits:

- **39464f4** "Always allow saves a prefix rule, never a local folder". `alwaysAllowMatch` (`packages/widget-sdk/src/rule-patterns.ts`) returns undefined when the saved match would name a home folder (`LOCAL_PATH`: `C:/Users/`, `/c/Users/`, `/home/`, `/Users/`). "Always allow" is then not offered (`session-manager.ts` `onPermissionRequest`), and the Permission review's `groupByRule` leaves such Asks out.
- **`scripts/publish.ts`** strips rules matching `LOCAL_PATH` out of `.kiln/policy.json` in each public tree. It also rewrites `Kiln: always allow ...` subjects that name a local folder.
- **`scripts/check-banned.ts`** already scans `.kiln/policy.json` (it walks every text file), so `npm test` refuses a home-folder rule left in the tree. The leaked rules were dropped by hand (c325f62, d5ecce0).
- **`cd` into the Session's own worktree is already allowed.** `shellRequest` reads `cd <worktree or a folder in it>` as a `worktree_read`, which the Org default allows. This works for every spelling (`C:\...`, `C:/...`, `/c/...`, quoted or not, followed by `&& ...`); checked against the SDK source. The leaked `cd` rules went into the *main checkout* (`cd /c/Users/<you>/projects/Kiln`) or Temp files, not into the Session's own worktree.

## Decisions

1. **Generalise or refuse?** Refuse. "Always allow" is not offered when the match it would save names **any absolute path**, not only a home folder (person's answer). There is no `{worktree}` placeholder: the Session's own worktree never asks, so nothing would use one.
   - Absolute means: a drive letter (`D:/`, `D:\`), a Git Bash drive (`/c/...`), a word starting with `/` (`/tmp/x`, `/etc`), or `~` (`~/x`). The test is on words of the match, so a relative `a/b` or a domain doesn't count.
   - `/dev/null` is not counted (it's in `2>/dev/null` everywhere and names nothing on the machine).
   - Allow once is unchanged. The Ask still comes up and the request still runs.
   - Prefix patterns already drop arguments (`git log C:/x` saves `git log *`), so the widened check bites only on commands saved as they stand (`cd`, `cat`, `rm`, redirects, `node -e`...).
   - It lives in `alwaysAllowMatch`, so the Permission review's proposals (`groupByRule`) follow without separate work.
2. **Plain `cd` into the Session's own worktree:** already allowed by default (see above). Nothing to build. Add a regression test with a real-looking worktree path under a home folder, so the widened check can never turn it back into an Ask.
3. **Commit subject** (person's answer): keep the match in the subject when it is one line of at most 72 characters: `Kiln: always allow other_commands "make *"`. Otherwise the subject names the action only, `Kiln: always allow other_commands (a long rule)`, and the full match goes in the commit body. `publish.ts`'s rewrite of old subjects stays as it is, for history.
4. **Clean-up check:** no new check in Kiln's Exit. check-banned already covers the tree, and publish.ts covers history. Add a backstop in the core instead: `addRules` (`packages/core/src/policy/policy.ts`) refuses with a 409 any rule whose match `alwaysAllowMatch` would refuse, before it writes or commits. That way no caller (Always allow, Permission review, anything later) can put a machine path in the file.

## Left open / out of scope

- `.kiln/policy.json` on the trunk still holds about 35 rules that name `/tmp/...` or `~/...` (e.g. `cd /tmp`, `cat > /tmp/fix.mjs <<'EOF'`). They aren't personal, so publish doesn't fail. This story doesn't delete existing rules; pruning them is the person's call, and the Permission review is the natural place.
- An env-var path (`"$TEMP"/x`) can't be resolved, so it isn't counted as absolute.
- The Policy file has grown to ~440 one-off rules. That's a separate concern, not this story.
