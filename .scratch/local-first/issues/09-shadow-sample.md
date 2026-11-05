# 09: The shadow sample

**What to build:** When a local attempt passes, a 1-in-5 draw (seeded in tests) decides whether a cloud reviewer also checks it against the Ticket's acceptance list. When the Ticket has no acceptance list, a cloud Session writes one first. The shadow verdict goes on the variant's record and never blocks the Item. A local reviewer's verdict on a local implementer's work never counts as the shadow review. The sample rate is a Setting. User stories 11–12 in `spec.md`.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] A seeded pick runs a cloud shadow review and records its verdict against the variant
- [ ] A Ticket with no acceptance list gets one written before the shadow review
- [ ] The shadow review never blocks or moves the Item
- [ ] A local review isn't counted as a shadow review
