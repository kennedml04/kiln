# 08: Story Stages and roll-up

**What to build:** The Story part of the default Workflow. A Story goes through Grill, then Spec (a Gate), then Tickets (a Gate). Each Stage that writes to the repo runs in its own Story worktree. The worktree is merged when the Exit is met (Grill) or when the Gate is approved (Spec, Tickets), so later Stages and Tickets branch from a default branch that already has those artifacts. The Exits are: the grill record exists; the spec exists, then the Gate; at least one Ticket child exists, then the Gate. The Spec and Tickets Gate Asks show the spec and the Ticket list. In the Tickets Stage, a Kiln tool lets the Session create child Ticket Items. A Story ships by itself when all its Tickets have shipped, and an Epic ships when all its Stories have.

**Blocked by:** 07

**Status:** resolved

- [ ] A Story moves Grill → Spec → Tickets through checked Exits and approved Gates
- [ ] Story Stages work in their own worktrees and never in the main checkout
- [ ] The Spec Gate shows the spec, and the Tickets Gate shows the Ticket list
- [ ] The Tickets Stage creates child Tickets through a Kiln tool, and they appear on the boards
- [ ] A Story ships when all its Tickets have shipped, and an Epic ships when all its Stories have
- [ ] Harness tests cover the full default Workflow, Epic to Shipped, with the fake Agent
