# 11: The GPU queue and its cutoff

**What to build:** A local Session takes the local Budget's pool slot (`LOCAL_POOL`) and one slot of the GPU monitor Widget's `gpu` pool. Waiting Sessions queue in arrival order, and their cards say they're waiting for the GPU. In local-first mode, a Ticket that has waited longer than the cutoff (30 minutes by default, a Setting) goes to cloud through the escalation path, recorded as "GPU busy". That doesn't count against any variant. Local-only Tickets keep waiting. Kiln never stops another program's GPU job, and never swaps in a smaller variant because the GPU is busy. User stories 21–23 in `spec.md`.

**Blocked by:** 07, 08

**Status:** ready-for-agent

- [ ] A second local Session waits while the first holds the GPU slot, and its card says so
- [ ] With a short cutoff in the test, a waiting local-first Ticket goes to cloud as "GPU busy", and no variant's record changes
- [ ] A local-only Ticket waits past the cutoff
