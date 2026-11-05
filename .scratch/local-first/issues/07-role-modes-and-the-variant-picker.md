# 07: Role modes, results and the variant picker

**What to build:**
- **Role modes:** each Workflow role gets a mode (local first, cloud only, local only), next to `model` and `fallbackModel`. Implementer and reviewer default to local first; the others default to cloud only. A per-Project local-only switch goes in `.kiln/settings.json`, and an install-wide one in core settings.
- **Results:** every local Stage attempt records a result against its variant (role, Ticket size, pass or fail, reason, wall time, tokens per second).
- **Ticket size:** small, medium or large, from the Item's earlier diff lines and files touched, else the Ticket's estimate, else medium. The thresholds are written in the module.
- **The picker:** a pure function of the results and the Ticket.
  - A variant with fewer than 5 results for the role goes first.
  - Otherwise the best pass rate for the role and size wins, with 1 in 5 exploring another variant (seeded random source).
  - A run of 3 failures at a size skips that size.
  - A pin on the role or the Ticket overrides it.
  - It returns the variant and a reason, and the Thread shows the reason.
- A local-first role with no enabled variant runs on cloud and says so.

User stories 8, 9, 16–19 in `spec.md`.

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] Unit tests on fixed results cover: a new variant first, the best rate wins, seeded 1-in-5 exploration, the 3-in-a-row cut-off per size, pins override
- [ ] A local-first Ticket's Thread names the variant and the picker's reason
- [ ] The Workflow validator accepts the role mode and rejects unknown values
- [ ] A local-only Project never starts a cloud Session (harness test)
