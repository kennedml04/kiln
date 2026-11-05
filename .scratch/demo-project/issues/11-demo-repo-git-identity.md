# 11: The demo repo has no git identity

**What to build:** Found in the first Live run (09). The demo repo's first commit passes `-c user.name=Kiln demo -c user.email=demo@kiln.invalid` for that commit only, so the repo has no identity of its own. On a machine with no global git identity, the griller could not commit. It made one up from the person's name and email and said so in its summary, and warned that later Stages would hit the same problem. `startDemo` should write the demo identity into the repo's own `.git/config` (`git config user.name` / `user.email`), so every Agent's commit works without borrowing the person's identity.

**Blocked by:** None

**Status:** needs-triage

- [ ] A fresh demo repo has `user.name` and `user.email` set in its local config
- [ ] An Agent's commit in a demo worktree succeeds with no global git identity and no `-c` flags
