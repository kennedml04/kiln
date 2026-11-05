# 08: Escalate to cloud when local fails

**What to build:** When a local-first Stage attempt fails its check (tests, the Exit, the turn cap or the time cap), Kiln starts a fresh Session on the role's cloud model in the same Stage. That Session is seeded with the failed diff, the failed check's output and the local variant's name. The Item doesn't move back. The card and the Thread show both attempts, each with its cost and verdict, and the failure counts against the variant. User story 10 in `spec.md`.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] A failing local attempt escalates to cloud, with the diff and the check output in the seed (harness test, fake local server and fake SDK)
- [ ] The Item stays in its Stage across the escalation
- [ ] The card shows both attempts with cost and verdict
- [ ] The local failure is recorded against the variant; the cloud result isn't
