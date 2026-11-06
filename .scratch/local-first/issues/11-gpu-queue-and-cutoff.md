# 11: The GPU queue and its cutoff

**What to build:** A local Session takes the local Budget's pool slot (`LOCAL_POOL`) and one slot of the GPU monitor Widget's `gpu` pool. Waiting Sessions queue in arrival order, and their cards say they're waiting for the GPU. In local-first mode, a Ticket that has waited longer than the cutoff (30 minutes by default, a Setting) goes to cloud through the escalation path, recorded as "GPU busy". That doesn't count against any variant. Local-only Tickets keep waiting. Kiln never stops another program's GPU job, and never swaps in a smaller variant because the GPU is busy. User stories 21–23 in `spec.md`.

**Blocked by:** 07, 08

**Status:** done

**Stage:** shipped

> Blocked 2026-11-05: 08 (escalation) has no code on any branch. 03 (local Sessions) and 07 (role modes, picker) have code on their branches but are not merged to master. The GPU queue mostly exists already (`LOCAL_POOL` is the same pool as the GPU monitor's `gpu`); box 1 needs 03 plus a "waiting for the GPU" card reason.

- [ ] A second local Session waits while the first holds the GPU slot, and its card says so
- [ ] With a short cutoff in the test, a waiting local-first Ticket goes to cloud as "GPU busy", and no variant's record changes
- [ ] A local-only Ticket waits past the cutoff
