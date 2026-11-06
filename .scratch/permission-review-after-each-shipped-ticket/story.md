---
title: Permission review after each shipped Ticket
stage: grill
---

Matt's words: "after every ticket is shipped do a review on all the permissions and what could be made better. Wasting a ton of time waiting on review since I can't just stare at the board all day."

When a Ticket ships (merged into the trunk), Kiln looks back at every permission Ask its Sessions raised and proposes changes, so the same kind of Ask stops blocking the next Ticket.

Numbers from 2026-11-06, after the permission fix shipped (14:34 UTC to 18:10 UTC): 39 permission Asks; median wait 10 minutes, p90 59 minutes; 14.3 Session-hours blocked; 33 Allow once, 5 Always allow, 0 Deny. Every one was allowed, so the waiting bought nothing.

What the review should do:
- Group the Ticket's permission Asks by command shape (rm of a file in the worktree, git checkout of a path, grep, for/while loops, uptime, tasklist, git fetch, reading a tool-results file outside the worktree) with count and minutes blocked.
- For each group Matt always allowed, propose one Policy rule, worded as a pattern rather than the exact command (Always allow today saves a literal string, e.g. `git checkout -q HEAD~1`, which never matches again). Read-only commands (grep, wc, uptime, tasklist, git fetch, shell loops whose body is read-only) are the first candidates.
- Flag commands that should stay Asks, or become Deny: killing processes by image name. `taskkill //F //IM node.exe` was allowed twice today (board-reset/02 at 13:07, safe-restart/02 at 18:09); the second one killed the Kiln core and every running Session.
- Post the proposals as one Ask to Matt (not one per rule), each with Apply / Skip, and apply the ones he picks to .kiln/policy.json as a normal Policy commit. Nothing changes the Policy without his answer.
- Notes for the implementer: the review must not write local folder paths into rules (publish refuses them); a Session waiting on an Ask also blocks restart-when-idle (core.stop awaits sessions.idle), so fewer Asks also means restarts that finish.
