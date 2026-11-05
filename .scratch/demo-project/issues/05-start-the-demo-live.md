# 05: Start the demo (Live)

**What to build:** `packages/core/src/demo/demo.ts` with `startDemo(mode)`, the `GET /api/demo` and `POST /api/demo/start` routes (Admin only), and Live mode end to end. `startDemo('live')` does this, in order:
1. If a demo Project already exists, stop its Sessions, unregister it (02) and delete its folder.
2. Copy the template (04) to `<dataDir>/demo-project/`.
3. Run `git init -b main` and commit everything as "Demo project".
4. Register the folder as the Project "Demo".
5. Record `demo.mode` in settings.

Live writes no `.kiln/workflow.json`, so the default Workflow and the wizard's role models apply. It refuses with 409, naming the missing roles, while any role has no model. Both routes refuse on a live instance, and `GET /api/demo` reports `available: false` there. See "Demo setup (core)" in `spec.md`.

**Blocked by:** 02, 04

**Status:** resolved

Per-run folder: each run goes in `<dataDir>/demo/<run>/` with its own Project id `demo-<run>` (name "Demo"), because a reused id brings the old run's Threads and events back; the previous run's folder is deleted after it is unregistered.

- [x] `POST /api/demo/start {mode:'live'}` on a dev core creates `<dataDir>/demo-project` as a git repo with one commit, and registers it as "Demo"
- [x] `GET /api/demo` returns `{available, mode, projectId}`; on a live core both routes refuse, and `available` is false
- [x] Live refuses with 409 naming the roles that have no model
- [x] Calling start twice leaves exactly one demo Project: a fresh repo whose only commit is "Demo project", with no Sessions or worktrees left from the first run
- [x] Other Projects, Budgets, Agents and settings are untouched by a restart
