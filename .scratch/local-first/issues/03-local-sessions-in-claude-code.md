# 03: Local Sessions in the Claude Code Agent

**What to build:** The Claude Code Agent runs a Session on a local model when its model is a local variant. That Session starts Claude Code with:
- `ANTHROPIC_BASE_URL` set to the local server;
- a fresh per-Session `CLAUDE_CONFIG_DIR` under the Widget's data folder;
- no Anthropic key, token or login in its environment (`claudeEnv()` in `widgets/claude-code/src/agent.ts` filters them for local Sessions);
- the variant's server model id as the model.

The Policy, the Kiln MCP tools, the no-attribution settings and the trailer checks stay exactly as for a cloud Session. Add the shim from 02 if it is needed. Usage goes to the local Budget at one turn per turn, with the variant id on each record. See "Local models through the Claude Code Agent" in `spec.md`.

**Blocked by:** 02, 04

**Status:** done

**Stage:** shipped

**Decided (2026-11-05):** local Agents get their own real check that judges outcomes, not the shared Agent contract. The last box moves to ticket 14.

**Open:** the last box. Four real runs on 2026-11-05 used `qwen-27b` at 64K behind llama-swap. The Widget's wiring works: requests reach llama-swap, a Permission Ask is raised, and the turns are counted on the local Budget. But no run reached the Exit within its time limit. The last run came after the usage fix. Its turns stayed at about 15 to 16K context with no context alarm, and it still timed out at 15 minutes. The next step is a run with the longer timeout, so the test prints the audit trail and the Session, to see whether the model is slow or going round in circles. 02's bare `claude -p` run did a smaller task in 44 to 72 s, without Kiln's MCP tools or system prompt.

**As built:** The core decides a Session is local. `VariantService.localModel(model)` in `packages/core/src/local/variants.ts` returns `{variantId, serverModelId, url, contextSize}` for a recorded variant. A disabled or removed variant, or a missing server URL, is a 409. The session manager puts that on the start command as `SessionStart.local` (`packages/widget-sdk/src/agent.ts`). It gives a local model's Stage only to an Agent that registers `runsLocalVariants: true`, which the Claude Code Widget does. In `widgets/claude-code/src/agent.ts`, `localClaudeEnv()` drops every `ANTHROPIC_*`, `CLAUDE*` and `KILN_*` variable from the parent. It then sets the 02 environment: the base URL, a dummy auth token, all alias models set to the server id, `-mid_conv_system`, the context size, and no telemetry. `CLAUDE_CONFIG_DIR` is a fresh mkdtemp folder under the Widget's data folder (`local-claude-config/<session>-*`), removed when the query ends. `--model` is the server model id. HOME is left alone so git still works, and with `settingSources: []` and the empty config folder no saved login is found. Policy, hooks, Kiln MCP tools and attribution settings are unchanged. Usage events are reported under the variant id with `costUsd` dropped, so a local Budget listing the variant counts one turn per turn. `maxBudgetUsd`, quota polling and rate-limit events are skipped for local Sessions. No shim was needed.

The first real runs found a bug. llama-server names each reply's model after its GGUF file, while Claude Code's `result.modelUsage` uses the requested id. So the usage tracker counted each turn twice: once correctly, and once as a single call the size of the whole turn. That set off the context alarm in every turn, and the Session went round renewing itself. The Widget now reads a local Session's assistant messages under the server model id (`asServerModel`).

Tests: `widgets/claude-code/test/local-session.test.ts`, with the fake SDK against the fake llama-swap. The fake SDK now calls `ANTHROPIC_BASE_URL`, logs the config folder, and keys `modelUsage` by the requested model as Claude Code does. The file also runs the unchanged Agent contract on a local variant. The real check (`KILN_REAL_LOCAL=1`) is not the shared contract, because a local model looks around first (`ls -la`) whatever the Ticket says, so the contract's first Ask is never its command. Instead it runs the answer Ticket through the Widget to its Exit, with read-only commands known and any other Ask allowed once, and checks the usage on the local Budget.

- [x] A Session whose model is a local variant reaches the local server, not Anthropic (fake SDK test on the logged options and environment)
- [x] No Anthropic credential or config folder reaches a local Session
- [x] The Policy, Permission Asks and attribution settings are the same as for a cloud Session (contract suite unchanged)
- [x] Usage records carry the variant id and draw on the local Budget
- [x] The gated real test from 02 passes through the Widget: moved to ticket 14 (a separate local real check)
