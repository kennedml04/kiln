# 07: The wizard's Demo step

**What to build:** On a dev instance, the setup wizard ends with a Demo step where Import used to be (01 removed Import there). The step has one sentence on what the demo is, then three choices: Replay (no models), Live (your Agents) and Skip. Replay and Live call `POST /api/demo/start`, and an error from it is shown in the step.

On a dev instance whose demo mode is Replay, Finish skips the "Choose a model for the … role" checks (`setup.ts` line 229). The Workflow roles step then shows "Replay needs no models; set them before running Live", and both the Agents step and the Workflow roles step may be left empty. Live, and every live instance, still require a model for every role. See "The setup wizard (shell)" in `spec.md`.

**Blocked by:** 01, 06

**Status:** ready-for-agent

- [ ] The dev wizard's steps end with Demo; the live wizard's still end with Import
- [ ] Picking Replay with no Agents and no role models set lets the wizard finish, and the board shows the Demo Project's Story at Grill
- [ ] Picking Live with a role unset shows the 409's message, naming the missing roles, and stays on the step
- [ ] Skip finishes with no demo Project; the demo can be added later from the board (08)
- [ ] Setup tests cover Finish with and without role models on dev+Replay, dev+Live and live
