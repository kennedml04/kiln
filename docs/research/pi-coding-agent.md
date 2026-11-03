# Pi coding agent: research for a Kiln Agent Widget

Researched 2026-11-03 from primary sources only: a shallow clone of `github.com/badlogic/pi-mono` (now `github.com/earendil-works/pi`; origin still resolves) at commit `a57438e9` (2026-11-03), plus the npm registry. Nothing was installed or run.

Paths below are relative to the repo root. Web links: `https://github.com/earendil-works/pi/blob/main/<path>`. `CA/` = `packages/coding-agent/`.

**Package name changed.** The package is now **`@earendil-works/pi-coding-agent`**. The old `@mariozechner/pi-coding-agent` stopped at 0.73.1 (2026-05-07) and is marked deprecated: "please use @earendil-works/pi-coding-agent instead going forward" (npm registry). See also `CA/CHANGELOG.md` around line 2341 (the 0.73.1 notes on the npm scope migration).

---

## 1. Driving Pi programmatically

It is TypeScript on Node.js (ESM), and Bun also works. It needs Node 22.19 or newer (`README.md`, "Getting started"). Kiln runs Node 24, so that is fine.

There are four non-interactive ways to drive it (`CA/docs/cli-integration.md` lines 9-16):

| Way | How | Notes |
|---|---|---|
| **SDK (in process)** | `import { createAgentSession } from "@earendil-works/pi-coding-agent"` | `const { session } = await createAgentSession({...}); await session.prompt(text); session.subscribe(ev => ...); session.steer()/followUp()/abort()/waitForIdle()/dispose()` (`CA/docs/sdk.md` lines 7-94). `AgentSessionRuntime` adds `newSession/switchSession/fork/importFromJsonl` (sdk.md line 58). Options: `cwd`, `model`, `thinkingLevel`, `modelRuntime`, `settingsManager`, `sessionManager`, `resourceLoader`, `tools`, `noTools`, `excludeTools`, `customTools` (sdk.md lines 96-108; `CA/src/core/sdk.ts` line 94). Examples are in `CA/examples/sdk/01..14-*.ts`. |
| **RPC (stdio JSONL, long-lived)** | `pi --mode rpc --no-session` | Commands go to stdin and responses and events come back on stdout. Correlation is by `id` (`CA/docs/rpc.md`). The typed Node client is `RpcClient`, exported from the package (`CA/src/modes/rpc/rpc-client.ts`). `package.json` also exports `./rpc-entry`. Full command list: `CA/docs/rpc-commands.md`. Protocol types: `CA/src/modes/rpc/rpc-types.ts`. |
| **JSON mode (one shot)** | `pi --mode json "prompt"` | Streams JSONL events, then exits. It takes no further input (`CA/docs/cli-integration.md` lines 34-52; `CA/docs/json.md`). |
| **Print mode** | `pi -p "prompt"` | Prints only the final text (cli-integration.md lines 20-32). |

**The intended way to embed it.** The docs say: "For an in-process Node.js or Bun integration, prefer the SDK. For a subprocess-based TypeScript integration, prefer the exported `RpcClient`" (`CA/docs/rpc.md` line 5; cli-integration.md line 72). OpenClaw is named as the real-world integration (`README.md`). Events used for completion: `message_end` is the authoritative message. `agent_end` is **not** final. `agent_settled` means Pi will not continue on its own (sdk.md lines 90-94; rpc.md lines 58-71).

## 2. Tool-call gating and permissions

- **There are no built-in permission prompts.** "It does not ask for approval before every tool call" (`CA/docs/security.md` line 3). Project trust only gates loading `.pi/` resources, not tool calls (security.md lines 27-33).
- **The hook is the `tool_call` extension event. It can block and is awaited asynchronously.** It fires after `tool_execution_start` and before the tool runs. A handler returns `{ block: true, reason?: string, terminate?: boolean }` and may mutate `event.input` in place (`CA/docs/extensions.md` lines 973-1013). Source checks:
  - `CA/src/core/extensions/runner.ts` lines 1249-1268 (`emitToolCall`) awaits each handler in turn and returns on the first `block`.
  - `packages/agent/src/agent-loop.ts` lines 738-762 awaits `beforeToolCall` with no timeout, gets an abort `signal`, and turns a block into an error tool result whose text is `reason` (default: "Tool execution was blocked"). If the run was aborted while held, the result is "Operation aborted".
  - `packages/agent/src/types.ts` lines 61-70 documents the same.
  - **So a handler can hold a call until an external answer arrives (for example a Kiln Permission Ask), then allow it (return `undefined`) or deny it with a message (`{block:true, reason}`).**
  - Thrown errors fail closed: "Extension failed, blocking execution" (`CA/src/core/agent-session.ts` around line 695).
  - Docs advise: "gate handlers should fail closed" (extensions.md line 425).
- **Parallel tool calls.** By default, sibling tool calls are *preflighted sequentially* (so `tool_call` handlers run one at a time), then run concurrently (extensions.md lines 979, 792-796).
- **Reference implementation:** `CA/examples/extensions/permission-gate.ts` (34 lines) calls `ctx.ui.select(...)` inside `tool_call` and blocks if there is no UI. Others: `protected-paths.ts`, `confirm-destructive.ts`.
- **Over RPC**, `ctx.ui.select/confirm/input` becomes an `extension_ui_request` on stdout. It **blocks until** the client sends `extension_ui_response` with the same id; an optional `timeout` auto-resolves it (`CA/docs/rpc-extension-ui.md` lines 1-63). In RPC mode `ctx.hasUI` is `true` (line 25). With the SDK, a Kiln extension can simply await a Kiln promise.
- **How calls are represented.** These are typed unions in `CA/src/core/extensions/types.ts` lines 1213-1284, narrowed with `isToolCallEventType("bash", event)`:
  - `bash`: `{ command: string; timeout?: number }` (seconds; `CA/src/core/tools/bash.ts` lines 39-41). On native Windows this runs in Git Bash (`CA/docs/windows.md`).
  - `powershell`: Windows only and optional (`types.ts`).
  - `edit`: `{ path, edits: [{ oldText, newText }] }` (`CA/src/core/tools/edit.ts` lines 20-35).
  - `write`: `{ path, content }` (`CA/src/core/tools/write.ts` lines 10-12).
  - `read` `{ path, offset?, limit? }`, plus `grep`, `find`, `ls`.
  - Custom and MCP tools arrive as `CustomToolCallEvent { toolName: string; input: Record<string, unknown> }`. MCP tools are named `mcp__<server>__<tool>`.
  - Calls made from codemode scripts carry `parentToolCallId` (extensions.md line 813).
- **Other events:**
  - `tool_result` can rewrite a result (extensions.md lines 1040-1074).
  - `tool_execution_end` sees every finalized call, including blocked ones (extensions.md line 369).
  - `user_bash` intercepts `!` commands typed by the user, and so does the RPC `bash` command (extensions.md lines 1078-1108).
- **Caveat:** an unknown tool or invalid arguments skip `tool_call` and end with an error result (extensions.md line 369). That is harmless for gating.

## 3. Custom tools and MCP

- **Custom tools:**
  - `pi.registerTool({ name, label, description, parameters /* TypeBox or JSON Schema */, execute(toolCallId, params, signal, onUpdate, ctx), promptSnippet?, promptGuidelines? })` inside an extension (`CA/docs/extensions.md` lines 1582-1625 and 2166-2260).
  - The SDK takes `customTools: ToolDefinition[]` (`CA/src/core/sdk.ts` line 94) or inline extension factories through `DefaultResourceLoader` (sdk.md lines 108-116).
  - On the CLI, `-e <path>` loads an extension (`CA/docs/cli.md` line 194).
  - Tools can be added at runtime and toggled with `pi.setActiveTools()` (extensions.md lines 1586-1588).
- **MCP is native as of 1.x, as a built-in extension.** It supports stdio and **streamable HTTP**; legacy SSE is not supported. It also handles OAuth and resources (`CA/docs/mcp.md` lines 1-84).
  - Config lives in `~/.pi/agent/mcp.json` or `.pi/mcp.json` (the project file only after trust), or comes from `pi.registerMcpServer(name, config)` in an extension (mcp.md lines 32 and 262).
  - **Exposure** defaults to `codemode`: tools are not declared to the model directly and are reached only through the `codemode` JS sandbox tool. Use `"exposure": "direct"` to declare Kiln's tools like built-ins (mcp.md lines 191-206).
  - MCP calls go through the same `tool_call`/`tool_result` hooks, so the permission gate covers them (mcp.md lines 252-256).
  - **SDK sessions do not load built-in MCP.** Add `createMcpExtension()` (plus codemode or tool-search if needed) to `DefaultResourceLoader.extensionFactories` and call `session.bindExtensions()` (sdk.md line 116; `CA/examples/sdk/14-codemode-mcp.ts`). The CLI loads it by default; `--no-mcp` turns it off.

## 4. Usage, cost and caching; subagents

- **Each assistant message carries `usage`** (`packages/ai/src/types.ts` lines 466-494; `CA/docs/message-types.md` lines 67-90 and 119-139):
  - Token fields: `input, output, cacheRead, cacheWrite, cacheWrite1h?` (the 1-hour-retention subset; Anthropic only), `reasoning?` (a subset of output), and `totalTokens`.
  - Cost fields: `cost { input, output, cacheRead, cacheWrite, total, totalFromProvider? }`. Cost is a catalog estimate unless the provider reports billed cost.
  - The message also carries `provider`, `model`, `responseModel?`, `stopReason` and `timestamp`.
  - Tool results can carry `usage` for nested model work, which counts toward session totals (message-types.md line 177).
  - `turn_end` gives you the per-turn message (extensions.md lines 715-750).
- **Session totals:**
  - RPC `get_session_stats` returns `tokens{input,output,cacheRead,cacheWrite,total}`, `cost`, `contextUsage` (`CA/docs/rpc-commands.md` lines 526-563).
  - The extension equivalent is `ctx.getContextUsage()`.
- **Prompt caching is first class:**
  - Retention tiers are `short` and `long`. Use `PI_CACHE_RETENTION=long` (`CA/docs/environment-variables.md` line 89).
  - Each model declares `promptCache: { short: 300, long: 3600 }` lifetimes in seconds (`CA/docs/models.md` lines 104-112).
  - `supportsLongCacheRetention` maps to Anthropic `cache_control.ttl: "1h"` or OpenAI `prompt_cache_retention` (`CA/docs/models-configuration.md` lines 138-164).
  - **Cache warming** (`cacheWarming: off|streaming|idle`, default `streaming`) sends refresh requests whose usage counts toward session totals (`CA/docs/settings.md` lines 21-23). The `cache_warming_decision` event reports and overrides it (extensions.md lines 912-929). **Kiln should count these refreshes or turn warming off.**
- **No built-in subagents.** "Pi ships with powerful defaults but skips features like sub-agents and plan mode" (`README.md`).
  - An example extension, `CA/examples/extensions/subagent/`, spawns child `pi --mode json -p --no-session` processes and sums their usage itself (`subagent/index.ts` lines 293-370).
  - Subagent usage reaches the parent only if the tool returns it in its result `usage`.

## 5. Models and providers

- **Many built-in providers** (`packages/ai/README.md` "Supported Providers", lines 62-97; `CA/docs/providers.md` lines 31-66): OpenAI, Azure, Anthropic, Google, Vertex, Bedrock, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel, DeepSeek, GitHub Copilot, OpenCode Zen/Go, Fireworks, Together, HF, Moonshot/Kimi, MiniMax, ZAI, Qwen, Cloudflare and others.
- **Local servers:**
  - OpenAI-compatible endpoints (Ollama, **LM Studio**, vLLM, SGLang, proxies) go in `~/.pi/agent/models.json` with `api: "openai-completions"` and `baseUrl` (`CA/docs/models.md` lines 43-79).
  - **llama.cpp** has a direct router integration and a `/llama` command (models.md lines 37-41; `CA/docs/llama-cpp.md`).
- **Subscription OAuth logins** (`packages/ai/README.md` lines 1789-1797; sources in `packages/ai/src/auth/oauth/*.ts`): **Anthropic (Claude Pro/Max)**, **OpenAI "Sign in with ChatGPT"**, OpenAI Codex (legacy, ChatGPT Plus/Pro), GitHub Copilot, OpenRouter, plus Kimi, xAI, Meta and Radius.
  - Credentials are stored in `~/.pi/agent/auth.json` via `/login`.
  - Precedence is `--api-key`, then auth.json, then models.json `apiKey`, then env vars (models.md line 23).
  - Whether a subscription's terms allow third-party harness use is a provider matter and not covered in the repo.
- **Choosing a model per session:**
  - CLI: `--provider`, `--model <provider/id[:thinking]>`, `--thinking`, `--models` (`CA/docs/cli.md` lines 55-74).
  - SDK: `createAgentSession({ model, thinkingLevel })` (sdk.md line 102; `CA/examples/sdk/02-custom-model.ts`).
  - Mid-session: RPC `set_model` / `set_thinking_level` (rpc-commands.md line 210).
  - The session records model changes and restores them on resume (models.md line 35).

## 6. Sessions

- **Interrupt/abort:**
  - SDK: `session.abort()` "stops the active operation and waits for the session to become idle" (sdk.md line 70).
  - RPC: `{"type":"abort"}` (rpc-commands.md line 94).
  - `agent_settled.aborted` flags it (extensions.md line 690).
  - Abort also cancels a held `tool_call`, because the signal is passed through (agent-loop.ts lines 746-753).
- **Steering and queued messages:**
  - `steer` is delivered after the current assistant turn's tool calls, before the next LLM call. `follow_up` is delivered after the run finishes.
  - SDK: `session.steer()` / `session.followUp()`; `prompt()` while streaming rejects unless you choose one (sdk.md lines 64-70).
  - RPC: `steer`, `follow_up`, `prompt` with `streamingBehavior`, and `clear_queue` (rpc-commands.md lines 5-130).
- **Resume:**
  - Sessions are persisted by default as JSONL tree files under `~/.pi/agent/sessions/`. `--session-dir` overrides the location (`CA/docs/sessions.md` lines 58-62).
  - CLI: `--continue`, `--session <path|id>`, `--session-id <id>` (opens or creates with a host-chosen id), `--fork`, `--no-session` (cli.md lines 78-107).
  - RPC: `switch_session`, `fork`, `clone`, `get_entries`, `get_tree`.
  - SDK: `SessionManager` and `AgentSessionRuntime.switchSession()` (sdk.md lines 36-60; `CA/examples/sdk/11-sessions.ts`).
  - The file format is documented in `CA/docs/session-format.md`.
- **System prompt:**
  - CLI: `--system-prompt <text|path>` replaces it; `--append-system-prompt` appends (cli.md lines 229-232).
  - Files: `~/.pi/agent/SYSTEM.md` / `APPEND_SYSTEM.md`, or `.pi/` project equivalents (project trust needed) (`CA/docs/configuration.md` lines 18-39).
  - SDK: `DefaultResourceLoader({ systemPromptOverride, appendSystemPromptOverride })` (`CA/examples/sdk/03-custom-prompt.ts`).
  - Per run: the `before_agent_start` event can change it (extensions.md lines 615-659).
- **AGENTS.md:**
  - Context files `AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` are loaded from the agent dir, the cwd and its parents, **regardless of project trust** (configuration.md lines 41-45; security.md line 57).
  - Turn them off with `--no-context-files` (cli.md line 214). The SDK example is `07-context-files.ts`.
- **Compaction:**
  - Automatic when `contextTokens > contextWindow - reserveTokens` (default 16384). Manual via `/compact` or RPC `compact`; toggle with `set_auto_compaction` (`CA/docs/compaction.md` lines 25-39; rpc-commands.md line 365).
  - It can retry once on context overflow.
  - Events: `session_before_compact` (can cancel or customize), `session_compact`, `session_compact_failed` (extensions.md line 534). In the JSON stream: `compaction_start` / `compaction_end`.

## 7. Versioning, cadence, licence, stability

- **Current version:** **1.5.0**, published 2026-11-02 (npm `latest`; `CA/CHANGELOG.md` line 14). There is also a `legacy-node20` tag at 0.74.2.
- **Cadence:** very fast. 62 published versions. 1.0.0 shipped 2026-10-01, then 1.0.1 through 1.0.4, 1.1.0, 1.2.0, 1.3.0, 1.4.0 and 1.5.0 within about five weeks (CHANGELOG headings; npm `time`).
- **Licence:** MIT, copyright 2025 Mario Zechner (`LICENSE`; npm).
- **Stability policy:**
  - "Lockstep versioning: all packages share one version... `patch` = fixes + additions, `minor` = breaking changes. No major releases" (`.pi/skills/release.md` line 10).
  - **So every minor bump may break the SDK or RPC.** Breaking-change sections appear in 1.5.0, 1.2.0 and even patch 1.0.3 (`CA/CHANGELOG.md`).
  - The docs call `pi --help` "authoritative for the installed version" of the CLI (rpc.md line 18).
  - No formal stability guarantee for the SDK or RPC was found.
  - Pin an exact version.

## Fit for Kiln (assessment, not from the sources)

- **Embedding.** Use the SDK in a Node child process that Kiln owns, or use RPC with a Kiln extension loaded through `-e`.
- **Policy.** Implement it as a `tool_call` handler that awaits the Kiln Policy or Permission Ask and returns `{block, reason}`.
- **Kiln tools.** Register Kiln's HTTP MCP server with `exposure: "direct"`, or wrap the tools as `customTools`.
- **Usage.** Read `message_end`/`turn_end` `usage` for per-turn figures. Count cache-warming refreshes, or set `cacheWarming: "off"`.
- **Subagents.** These are not native, so there is nothing to roll up unless an extension adds them.
- **Isolation.** Isolate config with a Kiln-owned agent dir and session dir, so the person's `~/.pi` settings, extensions and `.pi/` project files do not leak in. Use `--no-approve` or an in-memory SettingsManager.
