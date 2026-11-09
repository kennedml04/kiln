# 04: Partial landing failure sends the Item back for rework

**What to build:** If the monorepo lands and the client fails to, roll nothing back; send the Item back for rework with the note "monorepo changes landed on <branch/PR>; the client side didn't: <reason>". The rework Session reopens both worktrees, monorepo based on its updated main, and afterwards only the client lands. A conflicting monorepo merge from concurrent Items also goes back for rework. Blocked by the landing ticket.

**Blocked by:** None

**Status:** in-review

**Stage:** review
