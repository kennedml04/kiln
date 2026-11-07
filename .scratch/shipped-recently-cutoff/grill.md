# Grill: A cut-off for "Shipped recently"

Story: `.scratch/shipped-recently-cutoff/story.md` (Epic: board-ux). Grilled 2026-11-06, one Ask per question.

## Context

- The Reset board grill (`.scratch/board-reset/grill.md`, decision 6, 2026-11-05) said Reset board absorbs this Story, with no automatic cut-off. Reset board and the Shipped history page are now built (`packages/shell/src/work/ShippedHistory.tsx`, `BoardMenu.tsx`).
- "Shipped newest first" (`.scratch/shipped-newest-first/spec.md`) is specced but not built: it adds `Item.shippedAt` (ship time, from the event log) and sorts the shipped columns by it. This Story builds on that field.

## Decisions

1. **Go ahead, beside Reset board.** This Story is reopened, overriding board-reset decision 6: Shipped recently gets an automatic cut-off. Reset board stays as the way to clear by hand.
2. **The rule: by age, as a Setting.** A shipped column shows only Items whose ship time (`shippedAt`) is within the window. Choices: 1, 3, 7, 14, 30 days, or Off. Default 7 days. Off shows every shipped Item (today's behaviour, less archived ones).
   - **Items with no ship time are hidden** by the cut-off (moved into Shipped by hand in the Tracker, or shipped before the event log). Their age is unknown and they are almost always old. With the Setting Off they show, at the bottom, as in "Shipped newest first".
3. **Where older Items go: a widened Shipped history.** Shipped history lists **every** shipped Item, not just archived ones, newest first by ship time (Items without one last). Archived Items keep an "Archived" mark and Unarchive, and "Unarchive batch" stays as now. Each cut shipped column ends with a **"Show all (N older)"** link that opens Shipped history, filtered to that Project on a Project's board and unfiltered on Home. N counts shipped Items the cut-off hides (not archived ones).
   - The cut-off is a **view rule only**: nothing is archived, nothing is written to the database or the Tracker.
4. **Same rule for every kind.** Epics, Stories and Tickets are each judged by their own ship time. A shipped Ticket under a live Story is cut by its own time. No per-kind windows. A column left empty by the cut-off shows "Nothing shipped in the last N days" and the Show all link.
5. **One whole-Kiln Setting, Admin-set.** It sits on the Settings page ("Shipped recently shows: 1 / 3 / 7 / 14 / 30 days / Off"), editable by Admins, and applies to Home and every Project's board alike. Not per person, not per Project.

## Implied behaviour

- Archived Items stay hidden from the board whatever the cut-off says (Reset board wins).
- An Item drops out of the column when its age passes the window while the board is open (the minute clock from "Shipped newest first" drives it); no reload needed.
- A reworked and re-shipped Item uses its latest ship time, so it comes back into the window.
- The cut-off has no effect on Exits, roll-ups, the Scheduler or Reset board. Reset board still archives every shipped Item, including ones the cut-off hides.

## Still open (for the Spec)

- **Dependency.** This Story needs `Item.shippedAt` from "Shipped newest first" (its Ticket 1 at least). The Spec should mark it blocked-by that Story; this Session left the frontmatter alone.
- Whether the filter runs in the Shell (from `shippedAt` and the Setting) or the core sends a cut list plus the hidden count. Recommended: Shell, since the age moves with the clock; the count comes from the same list.
- Shipped history's route and filters once it lists all shipped Items: a "Show archived only" filter is probably wanted so the Unarchive flow stays easy to find.
- Wording of the Show all link and the empty-column line, and whether the link shows when N is 0 (recommended: hide it).
- `GLOSSARY.md`: update "Shipped history" (now all shipped Items, not only archived) and add the cut-off term if the first Ticket names it.
- `.scratch/board-reset/grill.md` decision 6 is now superseded; the Spec or first Ticket should add a note there.
