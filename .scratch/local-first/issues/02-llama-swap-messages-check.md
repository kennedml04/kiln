# 02: Check that Claude Code works through llama-swap

**What to build:** Find out whether Claude Code runs against llama-swap in front of llama-server: `POST /v1/messages` passes through, streaming works, and tool calls come back in Anthropic shape. Run Claude Code headless with `ANTHROPIC_BASE_URL` pointed at llama-swap, an empty `CLAUDE_CONFIG_DIR` and no Anthropic credential, on one small coding task with a coding model (a Qwen 27B or larger at 64K context). Run it **only while the GPU is free**: no render or other local model running, and never stop another program's job to make room. Write the findings, and any shim the Widget needs, into the Comments below. Wrap the check as a gated test (skipped unless an env var such as `KILN_REAL_LOCAL=1` is set) that ticket 03 can run. See decision 2 in `story.md` and "Local models through the Claude Code Agent" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] The findings say whether `/v1/messages`, streaming and tool calls work through llama-swap as they are, and name the model, quant and context used
- [ ] If anything needs translating, the Comments say exactly what, so the shim in 03 has a spec
- [ ] A gated real test exists and is skipped in the normal suite

## Comments
