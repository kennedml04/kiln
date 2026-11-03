# 05: A Ticket through Implementing

**What to build:** The first time work actually moves. When a Ticket enters Implementing, Kiln creates a git worktree and branch for it and starts a fresh Session with the Stage's Agent (the fake Agent in tests), seeded with the Ticket's artifacts. The Session works only in that worktree, and no Session writes to the Project's main checkout. When the Session finishes, Kiln checks the Exit itself: the branch has commits, the working tree is clean, and the Project's tests pass, using the test command from the Project settings in the repo's `.kiln` folder. A failing check goes back to the Session as feedback. A passing check moves the Ticket to Review. The markdown Tracker writes the new Stage and Status as a small Kiln-authored commit on the default branch that touches only those lines. The Item view shows the Thread streaming live, the Exit status (which parts are met or missing), and the worktree and branch.

**Blocked by:** 02, 04

**Status:** resolved

- [ ] A Ticket entering Implementing gets its own worktree and branch, and the Session runs there
- [ ] The Exit check verifies commits, a clean tree and passing tests; a reply from the Agent never counts as "done"
- [ ] A failing test run is sent back to the Session as feedback and the Ticket stays in Implementing
- [ ] A passing Exit moves the Ticket to Review, and the Tracker records it in a Kiln-authored commit touching only the Stage and Status lines
- [ ] The Item view shows the live Thread, the Exit status and the branch
- [ ] Two Tickets in Implementing at once get separate worktrees and never see each other's changes
- [ ] Harness tests drive all of this with the fake Agent; a browser test shows the Item view streaming
