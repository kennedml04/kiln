# Review: 03 Shell: fold Thread steps into 'Steps (n)' groups in ThreadLog

Reviewed commits c19159c, 11f2af4, 4468f32 (the diff from 5284bcb to HEAD) against the ticket and `spec.md`.

Verdict: **changes requested.** One real bug: the phone layout has no ellipsis, and its test can't catch that. The other items are small fixes and missing tests.

## What is right

- `toRows` groups consecutive `session.progress` entries correctly. Usage, quota and unknown `session.*` entries ride inside the group without being counted. The named session types, Asks, `exit.checked`, `digest.written` and `item.stage_changed` (all of them non-`session.*`) end the group.
- Groups are keyed by their first entry id, so open state survives as steps arrive. Fold state is component state and is not saved.
- The filling header shows the latest step in an `aria-live="off"` span, on the last row only.
- Toggles are `button[aria-expanded]`. A one-line note gets no toggle. The detail is a `<dl>` with `<pre>` for commands, notes and prompts. The 2,000-char cut has "show all". Write and Edit show only line counts.
- The scroll effect is keyed on the last entry id (and on fold changes), so the log keeps following the bottom as a filling group grows.
- `ProjectThreadView` uses `ThreadLog`, so the Project Thread is grouped too. Scratch chat has no `ThreadLog` (checked: only `ItemView.tsx` and `ProjectThreadView.tsx` render one). The Digest records that this is left for a follow-up.
- `steps.ts` reads tool inputs defensively (strings only) and follows the verb table.

## Findings

### 1. Phone: step lines and group headers lose their ellipsis (bug, confirmed)

`styles.css`: the `@media (max-width: 640px)` rule sets `display: flex` on `.steps-toggle` and `button.step-line`. `text-overflow: ellipsis` only applies to block containers, not flex containers. At phone width a long line is clipped with no "…". I rendered both styles in Chromium at 390px: the block version ends in `long long long long…`, the flex version is cut off mid-word (`long lo`). The flex version also drops the space after the `+`/`−` sign, because the whitespace between flex items collapses.

The phone test (`thread-steps.test.ts:134-140`) only reads `getComputedStyle(...).textOverflow`. That still reports `ellipsis` on a flex box, so the test passes even though nothing is drawn.

Fix: keep the lines `display: block` and reach 44px with `min-height: 44px; line-height: 44px` (or padding), or keep flex and put the text in an inner `<span>` with `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. Make the test check for a real ellipsis, e.g. that `scrollWidth > clientWidth` on the element that carries `text-overflow`, and that this element is not a flex or grid container.

### 2. The count in the filling header is still inside the polite live region (plausible a11y)

Only the latest-step text is `aria-live="off"`. `Steps (` / `{n}` / `)` are separate text nodes inside the `aria-live="polite"` log, and the default `aria-relevant` is `additions text`, so the count text changing on every step can be announced each time ("43", "44", …). The spec wants a screen reader to hear a new group, not every step. Opening a big group also adds many nodes to the live region at once, which may get read out. Not tested with a screen reader.

Suggestion: put the whole header label in the `aria-live="off"` span, or move the live region onto a wrapper around new rows only. A test can at least assert that the count sits inside an `aria-live="off"` subtree.

### 3. Opening a group while at the bottom jumps the view (minor UX)

The scroll effect also runs on `openGroups` and `openSteps`. If the person is at the bottom of a long log and opens a group or step higher up, the log snaps to the very bottom, and the header they just clicked can scroll out of view. Only re-pin when the opened row is the last one, or skip the snap for fold changes and rely on `lastId`. "Show all" growth at the bottom is not in the dependencies either, though that is harmless.

### 4. Test gaps against the ticket's list

- **Access:** not tested. The ticket and spec ask to extend the existing Thread access test with a progress entry. Steps use the existing route, so the risk is low, but the ticket names this test.
- **Fold persistence:** the test opens group 1 and a step in it, then sends steps that land in a new group 2. It never adds steps to the open, filling group. That is the case keying by first entry id exists for, and it is not exercised.
- **Filling header after finish, and kept after finish + reload:** the test ends the group with a person's message and reloads while the Session is still waiting (`wait_for_message` is the last script step). Neither `session.finished` nor a finished Session is covered.
- **Grouping split:** no explicit assertion that steps → message → steps give two groups with the right counts (it is only implied by `groups.nth(1)`).

### 5. Small spec drift in `steps.ts` (nit)

- `Read` adds `, lines a–b` only when both `offset` and `limit` are set. The spec says "when `offset`/`limit` given". With only `offset`, the line shows nothing extra.
- `stepDetail` takes `worktree` and ignores it (`void worktree`). Drop the parameter, or document why it is there.
- The spec's ticket 02 owns `steps.ts`. Merging the two branches will conflict, and the Digest already says so.

## Not in scope here

The card pulse and `run.lastStepAt` belong to the other tickets. They are not reviewed here.
