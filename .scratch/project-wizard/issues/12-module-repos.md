# 12: Module repos

**What to build:** Settings lists module repos in order, after the in-tree default. Each one is a git URL, fetched through the safe git fetch from `.scratch/skill-and-widget-repos/issues/01`. An earlier repo wins when two have the same module id. The Modules picker shows each module's source. A fetch failure keeps the last good copy and shows the error. User story 16 in `spec.md`.

**Blocked by:** 03, `.scratch/skill-and-widget-repos/issues/01`

**Status:** ready-for-agent

- [ ] A module repo added in Settings is fetched, and its modules appear in the picker with their source
- [ ] Order decides clashes
- [ ] A failed fetch keeps the last good copy and shows the error
