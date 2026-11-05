# Kiln

A rebuild of the Kiln board. It has a small core for orchestration and organization; every other feature is a widget. Widgets come from a public repo or a private local one. See `.scratch/kiln-v1/spec.md` for the design.

The old Kiln board must keep running during the build. Never write to its folder or its data.

## How to build and test

Node 24 and npm 11, npm workspaces. Node runs the TypeScript directly (type stripping), so only the Shell has a build step.

- `npm install`, then `npx playwright install chromium` once per machine.
- In a new worktree, run `npm ci` before anything else. Without its own `node_modules`, `@kiln/*` resolves to the main checkout's code and tests pass against the wrong files.
- `npm test` runs `npm run check` (lock file in step, banned patterns in `scripts/check-banned.ts`), builds the Shell, typechecks, then runs every `packages/*/test/**/*.test.ts` and `widgets/*/test/**/*.test.ts` with `node --test`. `npm run test:only` skips the build and typecheck.
- Layout: `packages/core` (core process and `kiln` CLI), `packages/shell` (React Shell, built by Vite), `packages/widget-sdk` (the shared core API types), `packages/testing` (the test harness), `widgets/*` (first-party Widgets).
- Tests drive Kiln from outside through `startTestKiln(t)` from `@kiln/testing` (a real core on a free port, a throwaway data folder, a temp git repo) and `openShell(t, kiln)` from `@kiln/testing/browser`. `kiln.installFakeAgent({ script })` starts the scripted fake Agent Widget (`packages/testing/src/fake-agent`) in that core. Never assert on internal modules or tables.
- Never run `kiln start` or `kiln stop` without `--port` and `--data-dir`: the defaults are the live Kiln (8300, `%LOCALAPPDATA%\Kiln`). Tests must never use 8300, 8195, `%LOCALAPPDATA%\Kiln` or the old board's folder.
- To try a change against a real core, run `node packages/core/src/cli.ts dev` from this worktree: a dev instance on a free port with a throwaway data folder, beside the live core. Stop it with `kiln stop --data-dir <folder>`. Stopping a dev instance also deletes its data folder (setup, Budgets, Agents, Projects), so never stop one to pick up a code change while a person is testing on it: ask first. Never restart the live core; `kiln restart` (Restart when idle) is the person's call. Tests that touch start at login set `KILN_STARTUP_ENTRY_FILE` so nothing is registered on this PC.
- Use only erasable TypeScript (no enums, namespaces or parameter properties) and import local files with their `.ts` extension.
- Publishing to GitHub: `node scripts/publish.ts` from the trunk (dry run; `--push` to publish). The repo is public, so `check-banned` refuses personal paths, control bytes, and the words in the `KILN_PRIVATE_WORDS` env var.

## Agent skills

### Issue tracker

Issues and specs are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage roles, each label string the same as its role name, written as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
