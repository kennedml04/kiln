# Review: 04 Shell: Shipped history pages and Archived badge on the Item page

## Second review (2026-11-06)

Reviewed: `master...405587f` on `kiln/ticket/board-reset/04`. Against master, the branch now changes only `App.tsx` (routes), `ItemView.tsx` (badge), the new `ShippedHistory.tsx` and `shipped-history.test.ts`.

**Verdict: approved.** Both must-fix findings from the first review are fixed. `node --test packages/shell/test/shipped-history.test.ts` passes 2/2 and `tsc --noEmit` is clean. The implementer reports a full `npm test` run of 542 pass, 0 fail. I didn't rerun the full suite.

### The first review's findings

1. **Built on an old ticket 03.** Fixed. Master (with 03's BoardMenu, hiding and toast) was merged in. `BoardMenu.tsx` links to `/shipped` and `/projects/:id/shipped`, and these routes match those links. The `db.ts` migration order is now master's, and the branch's diff no longer touches core or db at all.
2. **Refetch on every `item.updated`.** Fixed. The page now refetches only on `archive.*` events, or on an `item.updated` for an Item that is archived or already listed on the page (which covers a mark that has just been cleared).
3. Viewer test for hidden Unarchive. Not done. Optional.
4. Unarchive batch hidden while a search is on. Kept, and it's sensible. Still not written down in the spec.
5. Badge doesn't name its Reset (spec story 16). Not done. Optional, since the Ticket only asks for "Archived <when>".
6. Nits: "1 Item" is now singular. No CSS added yet. The demo-replay timeout change is no longer in the diff against master.

### New findings (minor, none blocking)

- **One extra refetch after each relevant event** (`ShippedHistory.tsx`, `refreshOn`). `refreshOn` is the event id when the event is relevant and `undefined` otherwise. When an unrelated event follows a relevant one, the value changes from an id to `undefined`, and that change alone reruns the effect. So each relevant event costs two `GET /api/archive` calls. It's cheap, but you can fix it by keeping the last relevant id in a ref or state, so irrelevant events leave the dependency unchanged.
- **Unused import.** `useCallback` is imported in `ShippedHistory.tsx` but never used.
- **Tests check the API, not the board.** The Unarchive tests read `GET /api/items`. They don't look at the cards coming back on the board, which the spec's Shell test list mentions. Ticket 03's tests cover the board hiding archived Items, so the risk is low.
