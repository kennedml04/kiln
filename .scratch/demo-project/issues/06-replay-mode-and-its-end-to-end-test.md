# 06: Replay mode and its end-to-end test

**What to build:** `startDemo('replay')` does two things on top of Live's setup. It writes the demo repo's `.kiln/workflow.json`: a copy of the default Workflow named `demo-replay`, with `agent: "fake"` and `model: "fake-model"` on every Stage that has a role. It also installs and approves the fake Agent from `packages/testing/src/fake-agent/` if it isn't installed yet, with `scriptFile` pointing at a copy of `packages/demo/replay/scripts.json` in the data folder. If the Widget source policy refuses that path, start fails with the policy's message; the policy is never loosened.

`scripts.json` plays the whole Story:
- **Griller:** asks 2 blocking questions, then writes and commits a fixed `grill.md`, which notes that Replay doesn't follow the answers.
- **Spec-writer:** writes `spec.md`.
- **Ticket-writer:** writes `issues/01-slugify-function.md` and `issues/02-slugify-cli.md`, with 02 `Blocked by: 01`.
- **Implementer:** has one script per Ticket (03). 01 writes `src/slugify.js` and its test. 02 writes `src/cli.js` and a subprocess test.
- **Reviewer:** writes the findings file.
- **All roles:** report a little usage on `fake-model`.

See "Replay: routing every role to the fake Agent" and "The replay scripts" in `spec.md`.

**Blocked by:** 03, 05

**Status:** ready-for-agent

- [ ] `packages/core/test/demo-replay.test.ts` passes. On a dev test core it:
  1. starts Replay
  2. answers both grill Asks
  3. approves the Spec and Tickets Gates
  4. approves Ticket 01's Review, then Ticket 02's
  5. asserts that `main` holds `src/slugify.js` and `src/cli.js`, that `node --test` exits 0 there, that the Story is `shipped`, and that no model Budget was drawn on
- [ ] A template test applies the 01 and 02 implementer writes to a fresh copy and gets `node --test` passing
- [ ] The wizard's role models never reach Replay Sessions: every Replay Session runs on the fake Agent
- [ ] A Replay start on an instance where the fake Agent is already installed reuses it, with no second install
