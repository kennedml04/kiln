---
title: Admin-editable word lists
epic: board-ux
stage: grill
blocked-by: []
---

# Admin-editable word lists

An Admin can see and edit every word list Kiln matches text against, in Settings, without touching code or env vars:
add words, remove built-in ones, and reword them. Example: "explicit" gets flagged when it's used to mean "exactly".
Some workplaces need different lists, so a list should be swappable as a whole.

To grill:
- Which lists exist: words that mark work private (the old board hides any card whose text matches them), the
  publish check (`KILN_PRIVATE_WORDS` in `scripts/check-banned.ts`), and any others.
- Where edits live (the data folder, not the repo) and whether built-in words can be turned off or only added to.
- Whole words or prefixes. Today's old-board matcher treats each word as a prefix, so a word also flags longer words that begin with it.
- Whether a change applies to earlier work (cards already filed as private) or only to new work.
- Who may edit (Admin only) and whether each change is logged.
