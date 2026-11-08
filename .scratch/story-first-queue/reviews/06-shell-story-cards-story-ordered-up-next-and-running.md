# Review: 06 Shell: Story cards, Story-ordered Up next and Running

Reviewed commit 8d38be1 (on top of the merge of 03) against the Ticket and spec user stories 1–3, 12, 15, 16, 18, 19 and Shell test 10/12.

Verdict: **changes requested**. One bug to fix (finding 1). The rest are smaller and can go in follow-ups.

## What matches the Ticket

- `StoryCard` shows the title, the Epic (or "Story"), the Stage, "N of M shipped", "N shipped, K open" for Maintenance, sub-rows, a Started badge for parked Stories, and ▲ ▼ controls.
- `UpNext` renders `scheduler.stories` that have nothing running. Drag and ▲ ▼ send Story ids, and on a Project board they also send `projectId` (`ProjectView.tsx`).
- Running groups by Story, with the running Ticket(s) as sub-rows. Shipped recently shows Stories, and Tickets only of Maintenance Stories.
- A Story's page lists its Tickets (`StoryTickets` in `ItemView.tsx`).
- The CSS uses the theme variables, so dark mode works; `--text-muted` and `--surface-3` are defined in both themes.
- The up-next-reorder Shell test now drags Story cards and uses ▼. Shell test 10 is added.
- `story-entries.ts` is a stand-in until ticket 05 lands, and the Digest says so.

## Findings

### 1. Bug: the Story's Ticket list is not in number order (`packages/shell/src/work/ItemView.tsx:57`)

`const number = (i) => Number.parseInt(/d+/.exec(...)...)`. The regex is `/d+/`, which matches the letter "d", when it should be `/\d+/`. So `number()` always returns 0 and the sort does nothing. The list then comes out in `childIds` order, which is the order the Tracker read the Items (`work.ts:239`). Zero-padded file names (`01-`, `02-` … `10-`) happen to read in order, so the bug doesn't show on this repo. It does show for `9-x` / `10-y`, for Maintenance Tickets with slug keys, and for any Widget Tracker. This breaks spec story 15 ("lists its Tickets in number order").

Fix: use `/\d+/`. Better still, share one `ticketNumber` helper with `core/src/flow/story-entries.ts:5`, which has the right regex, or put it in widget-sdk. Add a Shell assertion that opens a Story whose Tickets sort differently by text and by number, and checks the order. No test covers `StoryTickets` today.

### 2. ▲ ▼ and drag on Home push running Stories down the order (`HomeBoard.tsx` `UpNext.send`)

On Home, `send` passes only the Up next Story ids, with no `projectId`. Ticket 03's `reorder` without `projectId` puts the listed Stories above every unlisted one. A Story with a running Ticket and a further queued Ticket is not listed: the Digest decided it shows only in Running. So any move on Home drops that Story below every Up next Story, and its next queued Ticket starts after theirs. Once ticket 05 orders started Stories first, this mostly stops mattering. Until then it is a real change to start order. Two options:
- send the full `scheduler.stories` order with the moved Story swapped, or
- note it on ticket 05 so its "started first" rule is known to cover this.

### 3. The sub-row rule differs from spec story 12 (`StoryCard.tsx`)

Story 12 asks for *one* sub-row: the running Ticket, or else the waiting one, or else the next. Story 16 allows two when two Tickets run. The card lists every running Ticket *and* every waiting Ticket together, so a Story with one Ticket running and one at Review shows two rows in Running. This is small, but it is a spec deviation. Show waiting Tickets only when none are running.

### 4. The Home ▲ ▼ can send an id that `reorder` refuses (`story-entries.ts:17-20`)

A Story not in `story_order` gets position `MAX_VALUE` when one of its Tickets is running or waiting. If that Ticket started at once and is now waiting, and the Story has `next` from a Ticket in `up-next` with no queue entry, the Story shows in Up next. Moving it then sends an id that is not in `story_order`, so 03's `reorder` answers 409 and the board shows the error. This is an edge case and goes away when 05 replaces this file. Worth a line in 05's notes.

### 5. Nits

- `ProjectView.tsx:131`: `storyItems` is a second `useStore((s) => s.items)`, the same as `allItems` two lines above. Use `allItems`.
- Test 10 checks `/\d of 4 shipped/`. Since the seed is known, assert the exact count.
- No Shell test covers the Maintenance "N shipped, K open" text or a Project-board reorder sending `projectId`. The Digest already lists both as open. Add them, or carry them to ticket 07/08.
- The Ticket's test 10 also names "a Ticket's Ask in Needs you shows its Story's title and why line". That belongs to ticket 07 and is rightly not here, but test 10 isn't complete until 07 lands.

## Tests

`npm test` in this worktree: 555 pass, 1 fail, 13 skipped (18.6 minutes). The failure was `packages/core/test/ticket-flow.test.ts:308`, the stall rule test, with `No "session.stalled" event within 20000ms`. This branch doesn't touch that file. Re-run on its own, the file passes 9 of 9 (the stall test in 15 s), so this is a timing flake under full-suite load, not a regression. Re-run the suite after fixing finding 1.

## Second round (2026-11-08, at c17cbf4)

Verdict: **changes requested, again**. Nothing in this Ticket's code has changed since the first review. The Implementing Session after it left an empty Digest and no commits. Since c78786a the branch has only merged master: tickets 07 (Story line on Ticket cards and Asks) and 08 (Settings limit), plus status commits. None of that touches `StoryCard.tsx`, `HomeBoard.tsx`, `ProjectView.tsx`, `story-entries.ts` or `StoryTickets`.

- **Finding 1 is still open and must be fixed.** `packages/shell/src/work/ItemView.tsx:58` still reads `/d+/`. Fix it as described above and add a Shell test that checks the order of a Story's Ticket list, using keys that sort differently as text and as numbers (for example `9-x` and `10-y`).
- Findings 2 and 4 stay on ticket 05, which is back in Implementing and still not merged, so `story-entries.ts` remains the stand-in.
- Finding 3 (one sub-row) and the nits in 5 are unchanged. Fix finding 3 together with finding 1: it is a two-line change in `StoryCard.tsx`, putting waiting Tickets only when none are running.
- Ticket 07 has landed, so the Needs you part of Shell test 10 (the Story title and why line on a Ticket's Ask) is now covered by `packages/shell/test/needs-you.test.ts`. That nit is closed.

Tests at c17cbf4: `npm run check`, the Shell build and `npm run typecheck` pass. The Shell tests scheduler, boards, board-menu, needs-you and shipped-history, plus the core scheduler test, give 32 pass and 0 fail. I did not re-run the full suite: the code under review hasn't changed since the first run (555 pass, 1 known flake).
