# 01: A Widget installed from git can load its packages

**What to build:** A Widget installed from a git repo (the public Widget repo, or any other) starts with every package it imports at run time. Today the Claude Code Widget installed from the public repo can never start, so the setup wizard's Agents step installs an Agent that crashes. Found 2026-11-03 while trying the new Models step on a dev instance.

What happens today:

- `resolveWidget` (`packages/core/src/widgets/sources.ts`) clones the repo into `<data dir>/widgets/<id>/code/<commit>` and the Widget host (`packages/core/src/widget-host.ts`) runs the Manifest's command there. Nothing installs packages, so the checkout has no `node_modules`.
- The Claude Code Widget imports `@kiln/widget-sdk` at run time (`createWidgetClient` and `serveAgent` in `src/main.ts`, `ORG_POLICY_DEFAULT` in `src/agent.ts`, `decide` in `src/permissions.ts`). It also loads `@anthropic-ai/claude-agent-sdk`, its one npm dependency (`package.json`). It fails with `ERR_MODULE_NOT_FOUND: Cannot find package '@kiln/widget-sdk'`, crashes six times and is marked unhealthy.
- The OpenCode Widget avoids this by importing only types from the SDK, which Node strips. Its header comment says it runs "from a clone of the public repo that has no node_modules".
- The tests miss it: they install Claude Code from its folder in this checkout (`widgets/claude-code/test/install.ts`), where packages resolve from the repo root's `node_modules`. The wizard test uses the fake Widget repo.
- There is one lock file, at the repo root. `widgets/claude-code` has none of its own.

There are two separate problems:

1. **`@kiln/widget-sdk`.** Every Widget may want the SDK's run-time helpers, and they belong to the core API version the Manifest's `coreApi` names.
2. **Third-party packages** (`@anthropic-ai/claude-agent-sdk`). These must come from npm, at exact versions.

Options to decide (needs triage):

- **A. The core provides `@kiln/widget-sdk`.** The Widget host starts Node with a resolve hook (`--import` of a small loader) that maps `@kiln/widget-sdk` to the core's own copy, so a Widget gets the SDK that matches the running core. No copy and no install step. Widgets that are not Node are unaffected.
- **B. Kiln installs a Widget's packages.** When the checkout has a `package.json` with `dependencies`, Kiln runs `npm ci --omit=dev --ignore-scripts` in it at install and update time, before the Widget starts. That needs a lock file per Widget folder (add `widgets/claude-code/package-lock.json`, checked by `npm run check`). It needs network at install time, and a Widget whose install fails shows that as its problem instead of crashing.
- **C. Claude Code imports only types**, like OpenCode, and inlines the few SDK helpers it uses. It still needs B (or a vendored copy) for the Agent SDK.

Recommendation: A for the SDK and B for third-party packages, with `--ignore-scripts` and the lock file required, so an install never runs a package's scripts and never resolves a version the repo didn't pin.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The Claude Code Widget installed from a git repo (a temp clone of this repo in a test, never the network) reaches `ready` and registers its Agent and models
- [x] A Widget whose packages cannot be installed is not started, and its problem says why (no crash loop)
- [x] An update to a new commit installs that commit's packages in its own checkout; the running Widget's code and packages don't change underneath it
- [x] No package's install scripts run
- [x] A folder install (`kind: 'folder'`) behaves as it does now
- [x] The OpenCode Widget, which needs no packages, installs and starts as it does now, with no npm run
- [x] A test installs the first-party Agent Widgets through the wizard's Agents step from a clone of this repo, so this gap cannot come back silently

## Comments

2026-11-03: Built A and B, as recommended.

- **A.** The Widget host starts every `node` Widget with `--import packages/core/src/widgets/sdk-loader.ts`. It is a `module.registerHooks` resolve hook that maps `@kiln/widget-sdk` to the running core's copy. Widgets whose command is not `node` are unaffected.
- **B.** `resolveWidget` is now async. For a git checkout whose `package.json` lists `dependencies`, it runs `npm ci --omit=dev --ignore-scripts --prefix <folder>` with npm's own script and the core's Node, so npm need not be on the PATH (`KILN_NPM_CLI` overrides). A missing `package-lock.json`, or a failed `npm ci`, refuses the install or update with a 400 that says why (npm's last lines), so nothing is recorded or started. A running Widget keeps its checkout. A checkout whose `node_modules/.package-lock.json` exists is not installed again. Folder installs never run npm.
- `widgets/claude-code/package-lock.json` is new. `npm run check` (`scripts/check-lock.ts`) now also checks the lock of each Widget folder that lists packages.
- **Tests:**
  - `packages/core/test/widget-packages.test.ts` covers a local tarball package, scripts not run, an update getting the new commit's package, no lock, a broken lock, and a folder install.
  - `widgets/claude-code/test/install-from-git.test.ts` covers the real Widget from a copy of this repo.
  - The wizard test installs both real Agents from a copy.
  - `createWidgetRepoCopy` in `@kiln/testing` copies the working tree's Widget folders into a temp git repo. Its tests set `npm_config_offline=true`, so npm uses its cache only.
- **Not done:** a git install made before this change has a checkout with no `node_modules`. It is not repaired at start. Remove and reinstall it, or update it to a new commit.
