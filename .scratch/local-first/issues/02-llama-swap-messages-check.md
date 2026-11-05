# 02: Check that Claude Code works through llama-swap

**What to build:** Find out whether Claude Code runs against llama-swap in front of llama-server: `POST /v1/messages` passes through, streaming works, and tool calls come back in Anthropic shape. Run Claude Code headless with `ANTHROPIC_BASE_URL` pointed at llama-swap, an empty `CLAUDE_CONFIG_DIR` and no Anthropic credential, on one small coding task with a coding model (a Qwen 27B or larger at 64K context). Run it **only while the GPU is free**: no render or other local model running, and never stop another program's job to make room. Write the findings, and any shim the Widget needs, into the Comments below. Wrap the check as a gated test (skipped unless an env var such as `KILN_REAL_LOCAL=1` is set) that ticket 03 can run. See decision 2 in `story.md` and "Local models through the Claude Code Agent" in `spec.md`.

**Blocked by:** None

**Status:** resolved

- [x] The findings say whether `/v1/messages`, streaming and tool calls work through llama-swap as they are, and name the model, quant and context used
- [x] If anything needs translating, the Comments say exactly what, so the shim in 03 has a spec
- [x] A gated real test exists and is skipped in the normal suite

## Comments

**Verdict: works with env tweaks, no shim needed.** Checked 2026-11-05 with Claude Code 2.1.318 against llama-swap at `http://127.0.0.1:1240`, model `qwen-27b` = Qwen3.8 27B, Q4_K_M GGUF, 64K context (`-c 65536 -fa on -ctk q8_0 -ctv q8_0 --jinja`, all layers on an RTX 3090, about 20.7 GB VRAM loaded). Generation about 41 tokens/s, prompt about 260 tokens/s cold; Claude Code's first turn (about 14K input tokens) took 11 to 24 s to its first token, and the whole task 44 to 72 s.

**Raw HTTP, as is:**
- `POST /v1/messages` (non-streaming, one tool) passes through llama-swap to llama-server: 200, `type: "message"`, a `thinking` block then a `tool_use` block with `id`, `name`, parsed `input`, `stop_reason: "tool_use"`, Anthropic `usage`.
- Streaming works: `message_start`, `content_block_start` / `content_block_delta` (`thinking_delta`, then `input_json_delta` for the tool) / `content_block_stop`, `message_delta` with `stop_reason: "tool_use"`, `message_stop`.
- `POST /v1/messages/count_tokens` works (`{"input_tokens":318}`). `anthropic-beta` headers and the `?beta=true` query are ignored, not refused.
- Shapes that differ from Anthropic's, none of which Claude Code minded: `model` in replies is the GGUF file path, not the requested id; ids are `chatcmpl-...` and tool ids are random 32-character strings, not `msg_` / `toolu_`; thinking `signature` is `""`; in the stream the `tool_use` `content_block_start` has no `input: {}`, and the thinking block's `signature_delta` and `content_block_stop` (index 0) come after the tool block's deltas (index 1); `usage` reports the cached prefix as `cache_read_input_tokens`. Thinking blocks with an empty signature sent back in later turns are accepted.

**Claude Code, as is: fails.** Every request answers 500 `Jinja Exception: System message must be at the beginning`. Claude Code 2.1.318 puts its environment section in a mid-conversation `{"role":"system"}` message after the first user turn; llama-server hands it to the Qwen chat template, which raises. Claude Code's own fallback (resend with no system turns) only fires on a 400 or 422, so it retries the 500 until it gives up.

**Claude Code, with these env settings: works.** It wrote `sum.js` and `sum.test.js`, called Write and Bash, hit an ESM/CommonJS mistake, fixed it, ran `node --test` (pass) and ended with `subtype: "success"`, `apiKeySource: "none"`. All requests went to the local model; no `count_tokens`, haiku or other side calls were seen.
- `ANTHROPIC_BASE_URL=http://127.0.0.1:1240`, `ANTHROPIC_AUTH_TOKEN=<any dummy>`, `--model <server model id>`, a fresh `CLAUDE_CONFIG_DIR`, and no `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or other `ANTHROPIC_*` / `CLAUDE*` variable from the parent.
- `CLAUDE_CODE_MODEL_CAPABILITIES=-mid_conv_system` (required): turns the mid-conversation system turn off, so the environment section goes into the first user turn. The value can be scoped as `<model id>=-mid_conv_system`.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<the variant's context size>` (needed for long runs): an unknown model is otherwise assumed to have a 200K window, so Claude Code would never compact before llama-server's 64K limit. With it set the result reports `contextWindow: 65536`.
- `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL` = the same model id (precaution; nothing called them in this run).
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1` (precaution: nothing should leave the machine).
- Expected noise: stderr prints `[claude-code:unrecognized_model]`, and `total_cost_usd` / `costUSD` is a made-up price for an unknown model (about $0.14 for the task). Kiln counts a local turn against the local Budget, so 03 should ignore the dollar figure for local Sessions.

**Shim (only if a later Claude Code version brings the 500 back):** a pass-through in front of the server that, on `POST /v1/messages`, removes every `messages[i]` with `role: "system"` and appends its text blocks to the top-level `system` array (or prepends them to the next user turn), then forwards unchanged. Nothing else needs translating today.

**Gated test:** `widgets/claude-code/test/local-server.test.ts`, skipped unless `KILN_REAL_LOCAL=1`. It checks the non-streaming and streaming tool call shapes, then runs headless Claude Code on the sum task with the env above (`localClaudeEnv()` in the test is the env 03 needs). Settings: `KILN_LOCAL_BASE_URL`, `KILN_LOCAL_MODEL`, `KILN_LOCAL_CONTEXT`, `KILN_LOCAL_CLAUDE`. Run on 2026-11-05: 3 of 3 passed in 75 s.
