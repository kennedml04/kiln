# Spec: Demo project for dev instances

Status: ready-for-agent

Sources: `.scratch/demo-project/story.md` (the grill decisions of 2026-11-05), `docs/adr/0010-one-core-process-dev-instances.md`, and the code as of branch `tailscale-serve`.

## Problem Statement

Kiln is developed and tried out on dev instances (`kiln dev`), but a dev instance has nothing safe to work on.

- The setup wizard's Import step reads the old board's `projects.json` and registers every real Project it finds (EAST, room-render, homelab and more). Nothing in `packages/core/src/setup/setup.ts` or `packages/shell/src/SetupWizard.tsx` checks `config.devInstance`. Any Item started on a dev instance therefore does real work in a real repo. The only guard is a rule the owner has to remember.
- The only test repo is a hand-made scratch repo in `%TEMP%\kiln-scratch-repo`. It holds a README and a Story that adds a line to that README. It has no code and no tests, so the `tests_pass` Exit, Review findings, Ticket roll-up and a second merge never run.
- An end-to-end run needs the owner to set up Agents and models first. Someone Kiln is shared with cannot try a workflow without a Budget, and a run that hits a model problem shows nothing about the workflow.
- There is no repeatable check that the whole flow (Grill → Spec → Tickets → Implementing → Review → merge) still works after a change.

## Solution

Every dev instance can add a **demo Project**: a tiny JavaScript repo copied from a template in the Kiln repo into the instance's data folder. It comes with one ready-made Story, "Add `slugify(title)`". The demo runs in one of two modes:

- **Replay:** the scripted fake Agent plays every role, with no model calls. It is free, identical every run, and needs no Budget, which makes it the mode to share.
- **Live:** the instance's real Agents play the roles, using the models chosen in the wizard's Workflow roles step. This is the owner's end-to-end check.

In both modes the person answers the grill's Asks and approves the Gates in Needs you, so they see how Kiln is used hands-on. On a dev instance the wizard no longer imports real Projects. A harness test plays the whole Replay on every test run.

## User Stories

### Setting up a dev instance

1. As the owner, when I run the setup wizard on a dev instance, it does not offer to import my real Projects, so nothing I start there can change a real repo.
2. As the owner, the wizard on my live instance still imports my real Projects exactly as before.
3. As the owner, I can still add any folder as a Project by hand on a dev instance when I deliberately want one.
4. As someone trying Kiln, the dev wizard has a Demo step that explains the demo in a sentence and offers Replay or Live.
5. As someone trying Kiln without models set up, I can pick Replay and finish the wizard without setting up any Agent or Budget for the demo.
6. As the owner, I can skip the Demo step and add the demo later.

### Running the demo

7. As a person running the demo, after the Demo step the board shows a "Demo" Project holding one Story, "Add `slugify(title)`", at its Grill Stage.
8. As a person running Replay, the grill asks me two questions in Needs you. Any answer lets it carry on.
9. As a person running Replay, I approve the Spec Gate, then the Tickets Gate, and then the Review Gate of each of the two Tickets. After the last approval, `slugify` and its CLI are on the demo repo's `main` with their tests passing.
10. As the owner running Live, the same Story runs with my real Agents and the models the wizard set for each role. The demo then shows whether my real setup works end to end.
11. As a person running the demo, I can read each Stage's output (grill record, spec, Tickets, code, review findings) as real files in a real git repo.

### Running it again

12. As a person who has run the demo, a "Start demo" button on the demo Project lets me run it again, choosing Replay or Live.
13. As the owner, "Start demo" replaces only the demo Project. My other dev Projects, Budgets, Agents and settings are untouched.
14. As the owner, "Start demo" first stops any Session still running on the demo Project, so a half-finished run cannot write into the new one.

### Keeping it working

15. As the owner, a test in the normal suite plays the whole Replay. A Kiln change that breaks the flow, the template or the replay scripts fails that test.

## Implementation Decisions

### The template

- It lives at `packages/demo/template/`, a plain folder copied verbatim. It is not a workspace package, so its `package.json` is not installed by the monorepo.
- What it holds:
  - `package.json` with no dependencies.
  - `src/index.js`, a starter module with one existing function and its test in `test/index.test.js`, so `node --test` passes before the Story starts.
  - `README.md` describing the toy project.
  - `.kiln/settings.json` with `"testCommand": "node --test"` and `"mergeMode": "merge"`, merging locally because the demo repo has no remote.
  - `.kiln/policy.json`, starting from the scratch repo's.
  - `.scratch/slugify/story.md`, the ready-made Story at `stage: grill`. Its body says what `slugify` must do (lowercase, spaces and runs of punctuation become single dashes, leading and trailing dashes are trimmed). It also leaves two open questions for the grill: what to do with accented letters, and whether an empty result is an error.
- The replay scripts live outside the template, in `packages/demo/replay/scripts.json` (see below), so they are never copied into the demo repo the person reads.
- The template does not include `.kiln/workflow.json`. The demo setup writes one for Replay only (see below).
- **Ticket split:** the ticket-writer (scripted in Replay, a real model in Live) produces `issues/01-slugify-function.md` and `issues/02-slugify-cli.md`, with 02 `**Blocked by:** 01`. Kiln writes the `Blocked by` line today but the scheduler does not enforce it (see Further Notes). The Replay scripts are written so that 02 also passes when it starts before 01 merges.

### Demo setup (core)

- A new module, `packages/core/src/demo/demo.ts`, has one entry point, `startDemo(mode: 'replay' | 'live')`. It only works on a dev instance (`config.devInstance`). On a live instance it refuses with 409, and the route is not offered.
- `startDemo` does this, in order:
  1. If a demo Project exists: stop its running Sessions, unregister it, and delete its folder.
  2. Copy `packages/demo/template/` to `<dataDir>/demo-project/`.
  3. For Replay, write `.kiln/workflow.json` (below).
  4. `git init -b main`, commit everything as "Demo project", and register the folder as a Project named "Demo".
  5. For Replay, make sure the fake Agent is installed and reads the replay scripts (below).
  6. Record `demo.mode` in settings.
- **New core ability: unregister a Project.** Kiln cannot remove a Project today. Add `work.unregister(projectId)`: it stops the Project's Sessions, removes its worktrees and its DB row, and publishes `project.removed`. For now it is used only by `startDemo` on the demo Project, with no general UI. Whether to offer it everywhere is out of scope.
- Routes: `GET /api/demo` returns `{available, mode, projectId}`, where `available` is false on a live instance. `POST /api/demo/start {mode}` starts or restarts the demo. Only an Admin may call either.

### Replay: routing every role to the fake Agent

- Replay does not change how Agents are picked. The demo writes a Project Workflow at `.kiln/workflow.json`: a copy of the default Workflow, named `demo-replay`, in which every Stage with a role has `agent: "fake"` and `model: "fake-model"`.
- `setup.decorate()` fills in role models only for the Workflow named `default`, so the wizard's role choices never reach Replay.
- Live writes no `.kiln/workflow.json`, so the default Workflow and the wizard's roles apply, as on any real Project.
- **The fake Agent on a dev instance:** `startDemo('replay')` installs it from the Kiln checkout (`packages/testing/src/fake-agent/`), through the normal Widget install and approve calls, with `config.scriptFile` pointing at a copy of `packages/demo/replay/scripts.json` in the data folder.
  - The Widget source policy must allow that local path on a dev instance. If it doesn't, `startDemo` fails with the policy's message rather than loosening the policy.
  - It is approved as part of the Demo step, which the Admin clicks.
  - It is never installed on a live instance.

### The replay scripts

- `scripts.json` is a role-keyed `FakeAgentScripts`.
- **Griller:** two blocking `ask` steps (the template's two open questions, each with a recommended answer). Then it writes `.scratch/slugify/grill.md`, commits and finishes. The grill record is fixed text that records the recommended answers. A note in it says that in Replay the record does not follow the person's answers.
- **Spec-writer:** writes `.scratch/slugify/spec.md` and commits.
- **Ticket-writer:** writes the two Ticket files and commits.
- **Implementer:** needs different code per Ticket, but `SessionStart` carries only the role and the prompt, not the Item. Add an optional per-Item key to the fake Agent:
  - A script key may be `"<role>@<text>"`. It is used when `<text>` appears in the Session's prompt, which names the Item's title (`for the ticket "…"`). A plain `"<role>"` key is the fallback.
  - This touches only the fake Agent (`packages/testing/src/fake-agent/script.ts` and `main.ts`), not the Agent interface (ADR 0004).
  - A test pins the prompt wording that the demo's keys rely on.
- **Implementer for 01:** writes `src/slugify.js` and `test/slugify.test.js`.
- **Implementer for 02:** writes `src/cli.js` and `test/cli.test.js`. The CLI test runs the CLI as a subprocess and checks its output. `src/cli.js` imports `./slugify.js`, and that file comes from 01. So 02 must start after 01 has merged, or its `tests_pass` Exit fails. The Replay instructions shown on the demo Project say "approve Ticket 01's Review first" until the scheduler honours `Blocked by` (see Further Notes).
- **Reviewer:** writes the findings file at the path the prompt names ("No problems found; scripted review") and commits.
- Every script reports a little usage (a few hundred tokens on `fake-model`), so the usage display has something to show.

### The setup wizard (shell)

- On a dev instance (`GET /api/status` reports `instance: 'dev'`), the step list becomes `Login, Knowledge store, Install, Agents, Models, Workflow roles, Demo`. Import is replaced by Demo. A live instance keeps `Import`.
- The core also refuses `POST /api/setup/import` on a dev instance, with 409 and the message "Dev instances don't import real Projects; add one by hand if you mean to". The guard is not only in the UI.
- **The Demo step:** one sentence about the demo, then three choices:
  - Replay (no models)
  - Live (your Agents)
  - Skip
- Choosing Replay or Live calls `POST /api/demo/start`.
- **Finish without role models in Replay:** on a dev instance whose demo mode is Replay, Finish skips the "Choose a model for the … role" checks (`setup.ts` line 229). The Workflow roles step shows a hint: "Replay needs no models; set them before running Live". Both the Workflow roles step and the Agents step can be left empty. Live, and every live instance, still require a model for every role. `POST /api/demo/start {mode: 'live'}` refuses with 409 while any role has no model, and names the missing roles.

### The demo Project in the Shell

- `ProjectView` shows a "Start demo" button, with a Replay/Live choice, on the Project whose id matches `GET /api/demo`'s `projectId`.
- Pressing it calls `POST /api/demo/start` after a confirmation that the current demo run will be thrown away.
- While `mode` is Replay, a short note on the demo Project says what to do next: answer the Asks in Needs you, approve the Gates, and approve Ticket 01's Review before Ticket 02 starts.

## Testing Decisions

- **The Replay end-to-end test** is `packages/core/test/demo-replay.test.ts`, using the existing harness. It:
  1. Starts a test core as a dev instance and calls `POST /api/demo/start {mode: 'replay'}`.
  2. Answers the two grill Asks.
  3. Approves the Spec and Tickets Gates.
  4. Approves Ticket 01's Review, then Ticket 02's.
  5. Asserts that `main` in the demo repo holds `src/slugify.js` and `src/cli.js`, that `node --test` exits 0 there, that the Story is `shipped`, and that no model Budget was drawn on.
- **The template on its own:** a test runs `node --test` in a fresh copy of `packages/demo/template/` and expects it to pass. A second test applies the Replay implementers' writes for 01 and 02 to a copy and expects the same.
- **Dev guard:**
  - `POST /api/setup/import` returns 409 on a dev core and still imports on a live one (extend `setup.test.ts`).
  - The `/api/demo` routes refuse on a live core.
- **Restart:** calling `startDemo` twice leaves exactly one demo Project, with a fresh repo whose only commit is "Demo project", and no worktrees or Sessions left from the first run.
- **`work.unregister`:** removes the row, the worktrees and the running Sessions, and publishes `project.removed` (extend `projects.test.ts`).
- **Fake Agent per-Item keys:** `"implementer@Add slugify"` beats `"implementer"` when the prompt names that title, and falls back otherwise. A test pins the `for the ticket "…"` prompt wording.
- **Live mode** has no automated test, because it needs real models. It is checked by hand, and that run is the end-to-end test the session notes of 2026-11-04 call for.

## Out of Scope

- Mess scenarios, real-repo copies, and anything else in `.scratch/messy-demo/story.md`.
- An autoplay mode with no person in the loop.
- A cheap-models override for Live.
- A general "remove Project" in the UI.
- Enforcing `Blocked by` in the scheduler. This spec works around it; see Further Notes.
- Restarting a dev instance and keeping its data.
- Any demo on a live instance.

## Further Notes

- **`Blocked by` is not enforced.** `markdown-tracker.ts` writes `**Blocked by:**` into new Tickets, but the scheduler does not hold back a Ticket whose blocker is unshipped. If that is fixed first, the Replay note about the approval order and the ordering in the test can go.
- **The person's answers don't steer Replay.** The scripted grill record and spec are fixed, whatever the person answers. This is honest for a replay, and the grill record says so.
- **Settled at the Spec Gate (2026-11-05):**
  1. A dev instance running Replay may finish the wizard with no role models (see "The setup wizard").
  2. The fake Agent is installed straight from `packages/testing/src/fake-agent/`, not copied into `packages/demo/`. That keeps one copy, which the test suite already exercises. It is installed only on dev instances, and the only thing it can touch there is the demo repo, because the `demo-replay` Workflow is the only one that names it.
- **The old scratch repo** at `%TEMP%\kiln-scratch-repo` and its "E2E Test" Story are replaced by this demo and can be deleted after the first Live run passes.
