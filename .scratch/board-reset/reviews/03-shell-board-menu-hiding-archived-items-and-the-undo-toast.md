# Review: 03 Shell: Board menu, hiding archived Items and the Undo toast

Branch `kiln/ticket/board-reset/03`. I reviewed d08d029 (the Shell work) and 803c912 (a timeout raised on one core test) against the Ticket and the Shell section of `.scratch/board-reset/spec.md`.

**Verdict: approve, with test fixes recommended.** The ticket's behaviour is all there and works. The main problem is that one test step claims to check something it doesn't check.

## What I ran

- `npm run check`, `npm run build` and `npm run typecheck` all pass with no errors. The implementer's Digest said these hadn't been run; they now have.
- `node --test packages/shell/test/board-menu.test.ts`: 7/7 pass (Home and Project board at desktop and phone width, plus the Viewer test).
- A throwaway probe test, not committed: after a Reset I clicked a Main nav link. The toast was still visible on `/needs-you`. After `page.goto` (a full reload) the toast was gone.

## Checked against the Ticket

| Requirement | Status |
|---|---|
| BoardMenu ⋯, `aria-label="Board menu"`, 44px tap target | Done (`min-width/min-height: 44px`; the test checks the bounding box) |
| Reset board hidden for Viewers | Done and tested |
| Reset board disabled with "Nothing in Shipped" | Done (worked out from the store, limited to the Project when there is one) |
| Shipped history link (`/shipped`, `/projects/:id/shipped`) | Done; the pages belong to ticket 04 |
| Home: new "Board" toolbar row above Panels/Projects | Done |
| Project board: menu beside the `<h2>` name | Done |
| HomeBoard and ProjectView drop archived Items before grouping; counts show only what's visible | Done |
| Toast area above the router, `role=status`, bottom right on desktop, full width on phone | Done (the toast sits outside the routed `<main>`; the phone rule is at the Shell's existing 860px breakpoint) |
| "Archived N shipped Items." with Undo and dismiss, 10s | Done |
| Undo → unarchive by batch → "Put back N Items." for 3s | Done |
| Errors shown | Done (Reset and Undo failures both show an error toast) |
| Playwright at desktop and phone width | Done, but see findings 1 and 2 |

## Findings

### 1. The "navigating doesn't hide it" step tests nothing (should fix)

`packages/shell/test/board-menu.test.ts:37-39`: the step calls `page.goto(...)`, which reloads the whole page and wipes the in-memory toast. It then calls `toast.waitFor({ state: 'detached' }).catch(() => undefined)`, which can't fail either way. The behaviour does work: my probe showed the toast survives in-app navigation. The test just doesn't show it. Replace the step with an in-app navigation (click a Main nav link, or `history.pushState` through `followLink`) and assert the toast is still visible. Spec user story 10 depends on this.

### 2. The first test's name says it covers Undo, but it doesn't (nit)

`board-menu.test.ts:13` is named "…Undo puts the cards back". That test never presses Undo; the next test does. Rename it, for example to "Reset board empties Shipped, shows the toast, then is disabled".

### 3. The "Nothing in Shipped" text is never asserted (nit)

The disabled-state check matches `/Reset board/` and `isDisabled()`. The "Nothing in Shipped" label could be removed and no test would fail. Add a `toHaveText`/`getByText('Nothing in Shipped')` check.

### 4. Undo can be pressed twice (minor)

`toast.tsx:38`: the Undo button stays enabled while the unarchive request is in flight. A double tap, which is easy on a phone, sends two requests. The second returns `itemIds: []` and replaces the toast with "Put back 0 Items." Disable the button, or clear `undoBatchId`, once Undo is pressed.

### 5. Archived parents are gone from the New Item form (note, probably intended)

`ProjectView.tsx:129` filters `items` once and passes it to `NewItemForm` as well as to the columns. An archived (shipped) Epic or Story therefore no longer appears in the parent picker. That seems right, since nobody adds work under shipped Items, but it's a side effect the spec doesn't mention. Mention it in the PR, or pass the unfiltered list if the parent picker should keep those Items.

### 6. Small accessibility and layout points (nits, not blocking)

- The Home row has `role="toolbar"` and holds an `<h2>`. A toolbar should group controls only. A plain `<div>`, as on the Project board, or a `<header>` would be cleaner.
- The `role="menu"` list doesn't move focus into the menu or support arrow keys. Escape and clicking outside do work. A disclosure pattern (no `role=menu`/`menuitem`) would fit what is actually built. The tests use `menuitem`, so they would need to change too.
- On the phone the toast is `bottom: 0` with no `env(safe-area-inset-bottom)`, so on a notched iPhone it can sit under the home indicator.
- `showArchived` repeats the singular/plural logic that `plural()` in the same file already has.

### 7. Unrelated commit on the branch (note)

803c912 raises the timeout of `packages/core/test/demo-replay.test.ts` to 300s because it was slow under full-suite load. This is harmless and outside the ticket. Keep it, but don't count it as part of this ticket's work.

## Still open

- Shipped history pages and the Item page's Archived badge are ticket 04.
- Findings 1–3 are test-only. Finding 4 is a small product fix.

## Re-review after the rebase (2026-11-06)

The branch was rebased onto master (now b95c835 for the core archive work, 2c5f704 for the Shell). I checked it again.

- The Shell diff is the same as d08d029, apart from `HomeBoard.tsx`. Master took Panels off Home, so the "Board" toolbar row now sits directly above the Projects list. That still matches the Ticket ("above the Panels and Projects list"; there are no Panels now).
- 803c912 is gone from the branch (it was already on master), so finding 7 no longer applies.
- `npm run check`, `npm run build` and `npm run typecheck` pass. `node --test packages/shell/test/board-menu.test.ts packages/core/test/archive.test.ts`: 13/13 pass. The implementer reports that the full `npm test` passed (531 pass, 0 fail).
- Findings 1–6 above are still open. The rebase didn't touch them.
- One more nit (8): `.board-toolbar` uses `justify-content: space-between`. On a wide Project board this puts the ⋯ at the far right edge of the content, not right beside the name as the spec says. That's fine on a phone. On desktop, `justify-content: flex-start`, or a `margin-left` on the menu, would keep it next to the `<h2>`. It doesn't block approval.

**Verdict unchanged: approve.** Fix finding 1 (the navigation test) and finding 4 (double-tap Undo) before or with ticket 04.
