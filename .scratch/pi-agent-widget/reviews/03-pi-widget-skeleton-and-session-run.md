# Review: 03 Pi Widget skeleton and Session run

Branch `kiln/ticket/pi-agent-widget/03`, one ticket commit: 60cf9c2 ("Pi Widget skeleton: runs a Session with Pi's SDK in its worktree"). New `widgets/pi` (manifest, package.json + own lock file, `src/main.ts`, `src/agent.ts`, `test/pi.test.ts`) and the root lock file.

**Verdict: request changes.** The skeleton is sound and most of the Ticket is met. One bug leaves a Session running forever (F1), and must be fixed. One Ticket requirement is not met (F2): local providers do not come from Kiln's Budgets. Either build it or move it to a later Ticket on purpose. F3 and F4 should be fixed here or written into a later Ticket. The rest are nits.

## What I checked

- `node --test widgets/pi/test/pi.test.ts` on this branch: 2 pass, 0 fail (about 6 s). The implementer reports a full `npm test` at 547 pass, 13 skipped. I did not re-run the full suite.
- Pi is pinned exactly (`@earendil-works/pi-coding-agent` `1.5.0`) and has its own `package-lock.json`. That matches how `widgets/claude-code` ships its SDK.
- Pi runs in the Widget process through `createAgentSession()`, with `cwd` set to the Session's worktree. Pi session files go in the Widget data folder (`sessions-pi/<id>`), not the worktree. Good.
- **Isolation.** I read Pi's `DefaultResourceLoader` (`dist/core/resource-loader.js`):
  - `agentDir` is set explicitly to `<widget data>/pi-agent`, so `~/.pi/agent` (global AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, extensions, skills, prompts, themes, auth, models.json) is never read.
  - `noExtensions`, `noSkills`, `noPromptTemplates` and `noThemes` also turn off the project-level `.pi/` folders in the worktree.
  - Settings are `SettingsManager.inMemory(...)`, so neither the user's nor the project's `settings.json` loads.
  - The project `.pi/SYSTEM.md` and `APPEND_SYSTEM.md` load only when `isProjectTrusted()`. With in-memory settings I expect that is false. Worth one assert later (see F5).
  - Context files are filtered to those inside `cwd`, so AGENTS.md/CLAUDE.md in a parent folder (for example `%LOCALAPPDATA%\Kiln\worktrees`) are dropped and the worktree's own files load. This matches decision 5 of the spec.
- **Finished only on `agent_settled`.** `finished` comes only from `agent_settled`, from `interrupt`/`stop`, or from a failed start. It never comes from `agent_end`. A last assistant message with `stopReason: 'error'` gives `finished/error` with Pi's message. Good.
- **Metered key.** The key goes through `setRuntimeApiKey`, so it lives in memory only and `auth.json` stays empty. A missing secret fails the Session with a message that names `apiKey`, and that is tested.
- **Usage.** Usage is sent per assistant message. There is no `costUsd` for local models. `contextWindow` comes from Pi's model. Fine for this Ticket. Cache lifetime and compaction belong to Ticket 06.
- **W1.** `pickAgent` in `packages/core/src/flow/session-manager.ts:440` already prefers the ready Agent whose `model`/`models` include the Stage's model, then one with a model in the same Budget. So no core change was needed, as the Digest says. Pi registers its `models` with `local: true` when they have no `provider`.
- **Read-only stopgap.** Until the Policy hook ships (Ticket 04), a Session gets only `read`, `grep`, `find` and `ls` unless `allowAllTools` is set. That is a sensible default.

## Findings

### F1 (bug, must fix): a person's message to an interrupted Pi Session never finishes

`interrupt()` sets `run.paused = true`. Only `resume()` clears it. `onEvent` drops `agent_settled` while `paused` is set (`agent.ts:161`).

But the core does not call `resume` for a Session that ended `interrupted`. A Thread message to a Session in `RESUMABLE` state (`finished` or `interrupted`) sets it back to `running` and sends `agent.send_message` (`session-manager.ts:1082-1091`). `sendMessage` in the Widget does not check `paused` and does not clear it. So Pi runs the prompt, `agent_settled` arrives, and it is dropped. No `finished` is ever sent, and the Session stays `running` with no Exit check.

Fix: in `sendMessage` (or in `prompt`), set `run.paused = false` before prompting. Also add a test: interrupt (Stop all, or the Exit interrupt path), then post a Thread message, then expect `session.finished`.

A related point: `sendMessage` returns silently when `run.pi` is not yet set (the Session is still being created). A message sent in that window is lost. Queue it, or send it after `create` finishes.

### F2 (Ticket requirement not met): local providers come from Widget config, not from Kiln's Budgets

The Ticket says "Local providers come from Kiln's Budgets". Spec decision 5 lists "the local providers taken from Kiln's own Budgets" as part of what a Session loads. Here the person sets `localBaseUrl` and `models[]` in the Pi Widget's config instead. That duplicates what the Local server / Budgets setup already knows, and the two can drift apart. For example, a Budget can list a model the Pi config does not, and then `pickAgent`'s same-Budget fallback picks Pi for a model it cannot run.

The Digest says why: a Widget has no way to read the local server URL (`/api/local-server` is Admin-only). That is a real gap, but it needs a decision, not a silent deferral. Either add a Widget-readable view of local Budgets/servers to the core and widget-sdk (here or in a new Ticket), or have the person agree to config-based providers for now and update the Ticket text. Until then, this acceptance line is open.

### F3 (spec: "not the default Agent"): Pi can still be picked for Stages that never chose it

`pickAgent` falls back to `ready[0]` when the Stage names no Agent and either names no model or names one that is in no Budget. `widgets.list()` follows the host's Map insertion order. That is start order, so if Claude Code is restarting, crashed, or simply listed after Pi, a Stage that never chose Pi runs on Pi.

`main.ts` also registers `model: config.model`. So in that fallback the Session gets `model: pick.agent.model`, Pi's local default, and nothing says that Pi was chosen.

This is mostly a core matter, but this Ticket is where it starts to matter. Suggested fix: let a registration say it is not a fallback (for example `default: false`), or have the core fall back only to the Agent marked as default. Then add a test with Pi and the fake Agent both ready.

### F4 (test gap): the isolation test does not prove the user's Pi setup is shut out

The test sets `PI_CODING_AGENT_DIR` in the test process. But `widgetBaseEnv` (`packages/core/src/widget-host.ts:117-133`) passes only an allow-list of variables to Widget processes, and `PI_CODING_AGENT_DIR` is not on it. So the Widget never sees the canary folder, and the test would pass even without `agentDir`, `noExtensions` or the context filter. The canary extension also throws at load time, and Pi may only log that as a diagnostic, so it would not fail the run even if it loaded.

Suggested fix: put the canary where Pi looks by default and the Widget does inherit, which is `HOME`/`USERPROFILE` → `.pi/agent/AGENTS.md`. Node's test runner runs each file in its own process, so overriding those in this file is contained. Better still, add a canary extension with a visible side effect (it writes a file, or adds text to the prompt) and assert that the effect did not happen.

The same test should also check the read-only stopgap. The fake server receives the request's `tools`, so assert that `bash`, `edit` and `write` are not offered when `allowAllTools` is unset. This is the only safety line until Ticket 04, and nothing tests it today.

### F5 (nits)

- `onEvent` is subscribed with `void onEvent(...)`, so events are handled concurrently and the `progress`/`usage`/`finished` emits can arrive out of order. In practice `emit` probably queues in order, but chaining the handlers through one promise per run (as the core does with `session.queue`) would make `finished` always come last.
- `modelRuntime` rewrites `pi-agent/models.json` on every Session start, and every Session shares that file. Two Sessions starting together race on it. The content is the same today, so this is harmless, but a per-Session path (or writing it once at startup) is cleaner.
- `resume` sends a new prompt, "carry on", instead of reopening the session file. The Digest notes this, and it belongs to Ticket 05.
- The manifest's `network` list only allows `127.0.0.1`/`localhost` for local servers, so LM Studio or llama-swap on another LAN host is blocked. That ties in with F2: once providers come from Budgets, the hosts should come from there too.
- It is worth one assert or comment that the project's `.pi/SYSTEM.md` does not replace Pi's system prompt in a worktree, since that depends on `isProjectTrusted()` with in-memory settings.

## Acceptance against the Ticket

| Ticket line | State |
| --- | --- |
| widgets/pi first-party Agent Widget, Pi pinned | Done |
| createAgentSession() in the Widget process | Done |
| Registers as an Agent chosen per Stage, not default | Partly. Registers; can still be the `ready[0]` fallback (F3) |
| Session in its worktree with role prompt and model | Done |
| Loads worktree AGENTS.md/CLAUDE.md, none of the user's Pi extensions/skills/settings/models.json | Done in code; the test does not prove it (F4) |
| Local providers from Kiln's Budgets | Not done (F2) |
| Metered Budgets via API key as Widget secret | Done |
| Finished only on agent_settled | Done, apart from the paused case (F1) |
| W1: pick the Agent that offers the Stage's model | Already in core |
