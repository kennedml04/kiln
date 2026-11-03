# 07: Review Gate, merge and rework

**What to build:** A Ticket in Review gets a fresh review Session that writes its findings as an artifact. Once the findings exist, Kiln raises a blocking Review Ask, which is the Gate, showing the findings and the diff summary. Approving merges the Ticket's branch into the default branch, removes the worktree and moves the Ticket to Shipped. Rejecting with a comment sends the Ticket back to Implementing, where a fresh Session gets the comment and the findings. A merge conflict raises a blocking Decision Ask with a recommended fix (start a fresh Implementing Session to rebase). PR mode is out of this ticket (see 24).

**Blocked by:** 06

**Status:** resolved

- [ ] Entering Review starts a review Session that writes findings
- [ ] The Review Ask appears in Needs you with the findings and a diff summary, and it always blocks
- [ ] Approving merges the branch, removes the worktree and moves the Ticket to Shipped
- [ ] Rejecting with a comment returns the Ticket to Implementing, and the new Session is seeded with the comment
- [ ] A conflicting merge raises a blocking Decision Ask with a recommendation and leaves the default branch untouched
- [ ] Items move past a Gate only by approval, never by dragging
- [ ] A browser test approves a Gate
