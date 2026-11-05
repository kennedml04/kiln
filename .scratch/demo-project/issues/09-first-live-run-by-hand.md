# 09: The first Live run, by hand

**What to build:** Nothing new. This Ticket is the end-to-end check the 2026-11-04 session notes call for, done with the demo instead of the old scratch repo. On a fresh `kiln dev`:
1. Walk the wizard with the real Claude Code Agent and real role models, and pick Live.
2. Take the slugify Story through Grill, Spec, Tickets, both Implementings and both Reviews, to `shipped`.
3. Then press "Start demo", pick Replay, and run it once by hand too.

Write down every snag as a Ticket or a retro note. Once Live passes, delete `%TEMP%\kiln-scratch-repo`; the demo replaces it.

**Blocked by:** 07, 08

**Status:** ready-for-human

- [ ] Live reaches `shipped`, with `slugify` and its CLI on the demo repo's `main` and `node --test` passing
- [ ] Permission requests reached Needs you as Asks, and none stalled a Session silently
- [ ] Every Kiln worktree for the demo was removed after its merge
- [x] A hand-run Replay also reaches `shipped`
- [ ] Each snag found is filed; the old scratch repo is deleted
