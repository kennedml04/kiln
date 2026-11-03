# 13: Project Thread

**What to build:** Each Project has a Thread in the Shell where a person talks about the Project as a whole. Its Sessions can read everything in the Project (Items, artifacts, Digests, the repo) but run under a read-only Stage Policy, and their Kiln tools are scoped to the Project read-only. They propose changes only by raising Asks (for example, a Decision Ask to reprioritise, or one proposing new Items), and never make the changes themselves. When a person accepts such an Ask, the change is applied through Kiln as that person's action and audited under their name.

**Blocked by:** 10, 12

**Status:** resolved

- [ ] The Project Thread view exists and a person can chat in it
- [ ] Project Thread Sessions can read across the Project
- [ ] Any write a Project Thread Session tries is denied by Policy
- [ ] Proposals arrive as Asks in Needs you; accepting one applies the change as the person's action, and it is audited
