# 10: Local-only: retry on other variants, then propose a split

**What to build:** In a local-only Project or role, a failed attempt retries on the picker's next 2 variants, each seeded with the failures so far. When all three fail, a local ticket-writer Session proposes a split into smaller Tickets, and Kiln raises a blocking Ask showing the attempts and the proposed split, with Accept split, Reword and Park. Accept split writes the new Tickets through the Tracker. The wizard lets a local-only install finish with no cloud Budget. User stories 13–15 in `spec.md`.

**Blocked by:** 07, 08

**Status:** ready-for-agent

**Stage:** review

> Blocked 2026-11-05: needs 07 (role modes, results, picker; code on kiln/ticket/local-first/07, not yet on master) and 08 (escalation; no code on any branch). Also blocked by 08. Re-run once both are on master.

- [ ] A local-only failure retries 2 more variants, each seeded with the earlier failures (harness test)
- [ ] After the third failure, a blocking Ask shows the attempts and a proposed split
- [ ] Accept split writes the new Tickets; Reword and Park do what they say
- [ ] The setup wizard completes a local-only install with no cloud Budget
