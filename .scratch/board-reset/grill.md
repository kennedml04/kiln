# Grill: A "Reset board" button that clears shipped work off the board

Story: `.scratch/board-reset/story.md` (Epic: board-ux). Grilled 2026-11-05, one Ask per question.

## Decisions

1. **Where cleared Items go.** Reset puts an **archived** mark on Items. Board views (Home and each Project's board) hide archived Items. A new **Shipped history** page lists them, with search and Unarchive.
2. **Storage.** The archived mark lives **only in Kiln's database** (SQLite), keyed by Item id. Reset never touches the repo: `.scratch` files stay put, no frontmatter is written and no commit is made. Because Reset writes nothing to the Tracker, it works the same for any Tracker (markdown, GitHub Issues, Jira). If the database is lost, the shipped Items reappear on the board; no work is lost (ADR 0005 holds).
3. **What one press archives.** It archives every Item in Shipped at that moment: Epics, Stories and Tickets. That includes shipped Tickets under a Story that is still live (the Story's card keeps its Ticket count). It does not touch Sessions, Asks, or Epics that haven't shipped (including Epics with no Stories).
4. **Scope and who may press it.** The button is on both boards. On a Project's board it archives that Project's shipped Items. On Home it archives shipped Items in every Project the person can see. Admins and Members may both press it, and every press is written to the audit log (who, scope, how many Items, batch id).
5. **Undo, no confirm.** There is no confirm dialog. After the press a toast says "Archived N shipped Items. Undo", and Undo puts back exactly that batch. The Shipped history page offers Unarchive for each Item and "Unarchive batch" for each Reset, so undo still works after the toast is gone. Each Reset is therefore stored as a batch (id, who, when, scope, Item ids).
6. **Absorbs "A cut-off for Shipped recently".** This Story replaces `.scratch/shipped-recently-cutoff/story.md`. Reset is the only hiding rule on the Shipped column, and older shipped Items are found on the Shipped history page. There is no automatic age-based cut-off for now. An opt-in auto-archive Setting could come later if the button turns out not to be enough.
7. **Placement.** "Reset board" goes in the **board's top toolbar / overflow menu**, on desktop and on a phone alike. It does not go in the Shipped column header.

## Implied behaviour (follows from the above)

- An Item that ships after a Reset appears in Shipped as usual until the next Reset.
- An unarchived Item goes back to Shipped on the board.
- If an archived Item ever leaves Shipped (for example it is reopened), its archived mark is cleared, so live work is never hidden.
- Archiving is a view mark only. It has no effect on Exits, roll-ups (Story/Epic ship when all children ship) or the Scheduler.
- When nothing is in Shipped, the Reset menu entry is hidden or disabled (the spec decides which).

## Still open (for the Spec)

- Placement detail. The answer was "top toolbar / overflow menu". Spec decides whether Reset is a toolbar button or an entry in a ⋯ overflow menu (recommended: overflow menu, so a phone tap can't fire it by accident, given there is no confirm step), and where the History link sits (recommended: the same toolbar/menu).
- The Shipped history page: its route, whether it is per Project or all-Projects with a Project filter, how it sorts (by shipped date, newest first), and what the search covers (title, recommended).
- The cut-off Story still has to be closed, or marked as covered by this one, in its own file and Item. This Session didn't edit it, because that Item belongs to another branch.
- Glossary: add "Archived" and "Shipped history" to `GLOSSARY.md` when the first Ticket uses them.
