# Review: 01 Items: blockedBy, maintenance flag, storyWhy

Commit reviewed: 49458a9 (one commit on `kiln/ticket/story-first-queue/01`).

Verdict: **changes requested**. One bug (finding 1) shows up as false Project errors on this repo's own Tickets. Everything else asked for is there and tested.

How I checked: I read the diff against the Ticket and the spec's "Items: Blocked by and Maintenance" and "Why line" parts. I ran `blocked-by.test.ts`, `story-why.test.ts`, `tracker-contract.test.ts` and `project-files.test.ts` (all pass). I also ran `readScratch` on this repo's real `.scratch` folder to see which Project errors the new parser would show.

## Findings

### 1. Bug: a note in brackets followed by a full stop gives a false "matches no Ticket" error (must fix)

`resolveBlockers` (`packages/core/src/work/markdown-tracker.ts:78`) takes out `(…)` before it splits the line. So `01 (safe git fetches).` becomes `01  .`, and the leftover `.` is a token of its own. The trailing-punctuation strip turns that token into an empty string, it fails `BLOCKER`, and it is reported as `Blocked by "." matches no Ticket`. The real blocker (01) still resolves, so only the error is wrong.

On this repo the scan reports it for four real Tickets:

- `.scratch/skill-and-widget-repos/issues/02-widget-catalog-from-many-repos.md` (`01 (safe git fetches).`)
- `.scratch/skill-and-widget-repos/issues/03-…` (`01 (safe git fetches).`)
- `.scratch/skill-and-widget-repos/issues/04-…` (`03 (Skill repos and the Skills list).`)
- `.scratch/skill-and-widget-repos/issues/05-…` (`04 (skills reach every Session).`)

The implementing Digest names `01 (safe git fetches).` as a case it handles, but the test covers only `None (can start immediately).`, which the leading-None check catches, and `beta/01 (other story)`, which has no full stop.

Fix: drop tokens that are empty after stripping punctuation, or skip tokens made only of punctuation. Add `02 (note).` to the seed in `blocked-by.test.ts`.

### 2. Minor: the error message quotes the raw token, not the cleaned one

For `` `.scratch/skill-and-widget-repos/issues/01` `` (`project-wizard/12`) the message keeps the leading backtick. The parser strips backticks before matching but reports the token before stripping. Quote the cleaned token. Reporting that path form as an error is right, since the spec's form is `<story>/NN`.

### 3. Minor: `kiln-v1 23` gives two errors, and `23` alone could resolve to the wrong Ticket

`opencode-real-run/01` says `kiln-v1 23 (merged)`. It is split into `kiln-v1` (error) and `23`, and `23` is looked up in the Ticket's own Story. Here that Story has no Ticket 23, so `23` is reported too. If it had one, the line would quietly block on the wrong Ticket. The spec form is `kiln-v1/23`, so this is the file's fault, not the parser's. Still, fixing that one Ticket file (out of scope for this branch) or noting it for the person would stop it from showing as Project errors once this merges.

### 4. Minor: the `ProjectFileError.at` doc no longer fits

`ProjectFileError.at` is documented as "Where in the file, as a JSON path" (`packages/widget-sdk/src/work.ts:80`). The new errors use `at: 'Blocked by'`. Widen the doc (for example "a JSON path, or a field name for markdown records") so Shell code doesn't treat it as a JSON path.

### 5. Nit: `withTrackerErrors` is harder to follow than it needs to be

`packages/core/src/work/work.ts:166` tells Tracker errors apart from `.kiln` errors with a module-level `WeakSet` of error objects, and the `!problems.includes(e)` check is redundant. It works: `reload` rebuilds the `.kiln` errors fresh, and `refresh` filters out the old Tracker errors through the WeakSet. A simpler version would keep the `.kiln` errors on the Entry and always show `[...fileErrors, ...trackerErrors]`. Not required.

### 6. Nit: a Ticket can block itself

A Ticket whose `Blocked by` names its own number resolves to itself, and nothing reports it. The scheduler Ticket that reads `blockedBy` would then hold that Ticket forever. Consider reporting a self-block as a Project error here, since this is where the line is parsed.

## Checked and fine

- `Item.blockedBy?: string[]`, `Item.maintenance?: true`, `TrackerItem.blockedByKeys` / `maintenance` are in widget-sdk with docs.
- The parser handles `None`, empty and missing (empty no longer reads across a blank line because `field` now uses `[ \t]*`). It also handles `03`, `3`, `03-slug`, `#3`, `<story>/03`, comma or space separated, duplicates removed, and unmatched numbers reported as Project errors. All are tested through the API.
- Blockers are mapped to Item ids in `toItems`, the same way as `parentKey`. Keys that point at missing Items are dropped.
- `maintenance: true` in `story.md` front matter sets `item.maintenance`, and this is tested.
- `storyWhy` gives the first sentence, joins whitespace, cuts at 140 with `…`, and gives `undefined` for an empty description. It is exported from `@kiln/widget-sdk` and unit tested, including an exactly-140 case and `v1.2` inside a sentence.
- Tickets read from Session worktrees don't report problems (no `onProblems`), so errors from half-written worktree records don't leak into the Project.
- Changes to `blockedBy` publish `item.updated`, because `refresh` compares whole Items.

## Open (not for this Ticket)

- Nothing in the tracker-widget docs mentions `blockedByKeys` yet (from the implementing Digest).
- The scheduler and the Maintenance Story come in later Tickets.
