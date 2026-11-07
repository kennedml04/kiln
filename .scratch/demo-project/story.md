---
title: Demo project for dev instances
epic: projects-and-onboarding
stage: shipped
blocked-by: []
---
A dev instance (`kiln dev`) gets its own throwaway demo Project, so the owner can run a repeatable end-to-end check and other people can try a workflow, with no risk to a real repo. Today the dev wizard imports the real Projects from the old board, and starting an item in one of them on dev does real work in the real repo. The demo is a tiny JavaScript project, copied from a template folder in the Kiln repo into the instance's data folder. It runs in two modes: Replay (the scripted fake Agent, no model calls) and Live (the instance's real Agents). Grilled 2026-11-05; the decisions are below. The spec (`spec.md`) was approved the same day; it is split into 9 Tickets in `issues/` (01 to 04 can start at once).

## Decisions (grill, 2026-11-05)

1. **Audience:** both the owner (an end-to-end check before changes go live) and people Kiln is shared with.
2. **No real Projects on dev.** The dev wizard does not import the old board's Projects on a dev instance. A dev instance sees only the demo, plus any Project added by hand. The import code (`packages/core/src/setup/setup.ts`, `POST /api/setup/import`, the shell's `ImportStep`) does not check `config.devInstance` today, so that check is new. The real wizard is unchanged.
3. **Two modes:** Replay uses the fake Agent (`packages/testing/src/fake-agent/`) with role-keyed scripts and no model calls. Live uses the instance's real Agents.
4. **Codebase and Story:** a tiny JavaScript project using `node:test`, with no dependencies: one module plus tests. Its ready-made Story is "Add `slugify(title)`" (lowercase, dashes, strip punctuation), with edge cases for the grill to ask about. It splits into 2 Tickets: the function, then a small CLI that uses it. It replaces the README-only "E2E Test" Story in `%TEMP%\kiln-scratch-repo`.
5. **Where it lives:** a template folder, for example `packages/demo/template/`, holding the code, the `.kiln/` config, `.scratch/slugify/story.md` and the replay scripts next to it. Setting up the demo copies it into the dev data folder, runs `git init` and makes an initial commit. The markdown Tracker picks up the Story when the Project is registered.
6. **How it's added:** a Demo step in the dev wizard adds the demo Project and asks Replay or Live. The demo Project has a "Start demo" button to run it again later, with the same choice.
7. **Gates in Replay:** the person still answers the grill Asks (any answer works and the script carries on) and approves Review in Needs you. There is no autoplay mode for now.
8. **Reset:** "Start demo" deletes the demo Project and its folder, re-copies the template and re-registers it. Other dev data is kept. This does not depend on a restart that keeps data.
9. **Live models:** whatever roles the dev wizard set, with no cheap override. The run is small, so the strongest models still cost little.
10. **Automated test:** a harness test installs the demo on a test core, plays the whole Replay with scripted answers to the Asks and Gates, and checks that the slugify code lands on the demo repo's `main` with its tests passing. It runs with the normal suite.

## Comments

**2026-11-05** Raised in chat. The clean demo proves the workflow but hides real-world mess (large diffs, slow tests, tricky merges). That is the follow-up Story `.scratch/messy-demo/story.md`.
