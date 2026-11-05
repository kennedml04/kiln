# 09: The first Live run, by hand

**What to build:** Nothing new. This Ticket is the end-to-end check the 2026-11-04 session notes call for, done with the demo instead of the old scratch repo. On a fresh `kiln dev`:
1. Walk the wizard with the real Claude Code Agent and real role models, and pick Live.
2. Take the slugify Story through Grill, Spec, Tickets, both Implementings and both Reviews, to `shipped`.
3. Then press "Start demo", pick Replay, and run it once by hand too.

Write down every snag as a Ticket or a retro note. Once Live passes, delete `%TEMP%\kiln-scratch-repo`; the demo replaces it.

**Blocked by:** 07, 08

**Status:** ready-for-human

- [x] Live reaches `shipped`, with `slugify` and its CLI on the demo repo's `main` and `node --test` passing
- [x] Permission requests reached Needs you as Asks, and none stalled a Session silently
- [ ] Every Kiln worktree for the demo was removed after its merge
- [x] A hand-run Replay also reaches `shipped`
- [ ] Each snag found is filed; the old scratch repo is deleted

## The Live run, 2026-11-05

Live reached `shipped` on dev instance 8412 (demo repo `demo\3`): `src/slugify.js` and `test/slugify.test.js` on `main`, `node --test` 14 of 14. The slugify Story never asked for a CLI, so there is none; the first box's "and its CLI" was out of date.

Snags:
- Every merging Stage (Grill, Spec, Tickets, both Reviews) left its finished `claude.exe` running in the worktree, so `worktree remove` failed with "Permission denied" after the merge. After the Grill the Item stayed put; after a Gate the review Ask came back on every approval, an approval loop. Cleared by hand each time (stop the process, delete the folder, approve once more). Issue 10.
- After the hand fix at Grill the Item sat at Spec / backlog with its run record still on the grill, and it wasn't clear whose move it was: nothing showed that the person had to press Start. Raised as a Needs-you flag on Kiln (the old board): auto-start, a clear "your move" cue, or a per-Stage setting.
- Claude Code commits carried a Co-Authored-By trailer (the griller's, a Ticket's), and one reached the demo repo's `main`. Fixed on branch `no-coauthor`: attribution off, a built-in Exit check, the merge and PR push refuse, and permission requests with a trailer are denied outright.
- The demo repo has no git identity of its own, so the griller borrowed the person's. Issue 11.
- The setup wizard gives Opus to three of the five roles (griller, spec-writer, reviewer) and never suggests a local model. To revisit.
