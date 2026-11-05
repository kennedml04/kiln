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

**Status:** resolved

- [x] `packages/core/test/demo-replay.test.ts` passes. On a dev test core it:
  1. starts Replay
  2. answers both grill Asks
  3. approves the Spec and Tickets Gates
  4. approves Ticket 01's Review, then Ticket 02's
  5. asserts that `main` holds `src/slugify.js` and `src/cli.js`, that `node --test` exits 0 there, that the Story is `shipped`, and that no model Budget was drawn on
- [x] A template test applies the 01 and 02 implementer writes to a fresh copy and gets `node --test` passing
- [x] The wizard's role models never reach Replay Sessions: every Replay Session runs on the fake Agent
- [x] A Replay start on an instance where the fake Agent is already installed reuses it, with no second install

**Notes from the build:**
- Kiln starts no Session on a model in no Budget, so Replay adds a metered Budget `replay` holding only `fake-model` (unless that model already has one). The fake Agent reports no cost, so its turns are recorded and draw nothing; the wizard's Budgets are never drawn on.
- Both Tickets start when the Tickets Gate is approved. Ticket 02's implementer writes the same `src/slugify.js` as 01, byte for byte, so its `tests_pass` Exit passes before 01 merges and the two branches merge cleanly.
- Approving two Ticket Reviews at once can fail the second merge on `.git/index.lock` (Gates serialize merges per Item, not per repo); Kiln re-raises that Review. The test waits for 01 to ship before approving 02.
- The board shows the Story `shipped` a moment before the Tracker commits its `stage: shipped` line, so the test waits for `main` to come clean.
- The harness now starts the core without `NODE_TEST_CONTEXT`: with it, a `node --test` the core ran for a `tests_pass` Exit exited 0 even when its tests failed.
