# Review: 07 Shell: Story title and why line on Ticket cards and Asks

Commit reviewed: 89e88e5. Verdict: **approve, with two small follow-ups.**

## What was checked

- `StoryLine` / `useStoryOf` (`packages/shell/src/work/StoryLine.tsx`): title and `storyWhy(description)` from widget-sdk, one line each, ellipsised (`white-space: nowrap; text-overflow: ellipsis`), why line muted. Only Tickets with a parent Story in the store get one. Matches the spec's Shell section and user story 13.
- `ItemCard`: the Story line sits under the Ticket's title. `ItemCard` is used on Home (Running and its other columns) and on the Project board, so both get it. The `memo` still works because `useStoryOf` subscribes to the store itself.
- `ItemView` (Thread header): the Story line sits under the `<h2>`.
- `AskSubject` (`NeedsYou.tsx`): Ticket Asks get the Story title and why line, and Story Asks get just the why line (user story 14). Chat and Project Thread Asks are unchanged.
- `widget-sdk/src/work.ts`: the duplicate `maintenance` fields a merge left in `Item` and `TrackerItem` are removed, and one of each is kept. This was needed for typecheck to pass.
- Test: `needs-you.test.ts` now checks that the Ask shows the Story title "Home board" and its why line (acceptance 3). Ran it: it passes. Typecheck and the Shell build are clean.

## Findings

1. **Minor: invalid nesting, and the line sits in the wrong place in Needs you.** `AskSubject` is rendered inside `<p className="ask-meta">`, so `StoryLine` puts a `<div>` holding `<p>`s inside a `<p>`. React warns about this in dev (validateDOMNesting). Also, `.ask-meta` is a wrapping flex row, so the Story line becomes another chip in that row next to the Ticket link instead of a block under the subject. The ellipsis still works because the flex item wraps and shrinks (`min-width: 0`). Fix: render the Story line under the meta row, or render `StoryLine` with `<span>`s (`display: block`) and give it `flex-basis: 100%` in `.ask-meta`.
2. **Minor / known: the Story must be in the store.** If the parent Story Item isn't loaded, the line is silently missing. The store loads every Project's Items at start, so in practice this should only happen on a brief race. Acceptable.
3. **Coverage gap (not blocking):** only the Needs you case is tested. No test checks the Story line on an `ItemCard` (Running or the Project board), in the Thread header, or the why-only line on a Story Ask. The Shell test the ticket asks for covers acceptance 3 only through Needs you, so this meets the ticket. A test on the Project board card would cheaply guard the rest.

## Not in scope here

- Ticket sub-rows inside the Story cards (ticket 06) don't repeat the Story line, which is right since they already sit under their Story.
