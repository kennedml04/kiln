---
title: A "Reset board" button that clears shipped work off the board
epic: board-ux
stage: spec
blocked-by: []
---
After a long run the board holds dozens of shipped Stories and Tickets beside the live work (58 shipped against 13 Stories in backlog on the Kiln Project), and finding what is moving takes scrolling. The person wants one button that clears the finished work away and leaves only what is still in play, without losing the history: shipped Items stay in git and in `.scratch`, and can be found again.

Related: "A cut-off for Shipped recently" (`.scratch/shipped-recently-cutoff/story.md`) hides old shipped Items by age; this Story is the one-press version. Grill whether one absorbs the other.

## To grill

- What Reset clears: shipped Tickets and Stories only, or also empty Epics, stopped Sessions and answered Asks?
- Where cleared Items go: an "archived" flag the board filters out, a Shipped history page, or a filter on the existing Shipped column?
- Per Project or the whole board, and who may press it (Admin or Member)?
- Undo: an "Unarchive" on the history page, or an Undo toast right after the press?
- Whether Reset touches the repo (moving files under `.scratch`) or stays in Kiln's database only.
- The phone layout: where the button sits on a narrow screen, and a confirm step before it runs.
