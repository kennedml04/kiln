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

**Status:** needs-triage

- [ ] The Claude Code Widget installed from a git repo (a temp clone of this repo in a test, never the network) reaches `ready` and registers its Agent and models
- [ ] A Widget whose packages cannot be installed is not started, and its problem says why (no crash loop)
- [ ] An update to a new commit installs that commit's packages in its own checkout; the running Widget's code and packages don't change underneath it
- [ ] No package's install scripts run
- [ ] A folder install (`kind: 'folder'`) behaves as it does now
- [ ] The OpenCode Widget, which needs no packages, installs and starts as it does now, with no npm run
- [ ] A test installs the first-party Agent Widgets through the wizard's Agents step from a clone of this repo, so this gap cannot come back silently
