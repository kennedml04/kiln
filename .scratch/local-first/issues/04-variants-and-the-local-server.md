# 04: Variant records and the local server interface

**What to build:** A core record for each **variant**: id, display name, server model id, GGUF file (path, size, quant), settings (context size, GPU layers, KV cache type, threads, extra flags), state (enabled, disabled with a reason, removed) and the last smoke test. Add one local-server interface (list models, read and write one entry in its config, reload, send a test request) with llama-swap as its first implementation. The llama-swap config path is a Setting, never a hard-coded folder. Entries written by hand and comments in the YAML survive Kiln's edits. Models the server already lists show up as variants that can be enabled. The smoke test loads the model, sends one short Anthropic Messages request that asks for a tool call, and records load time, tokens per second and pass or fail. API only; the Settings page is 06. See "Variants and Add a model" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Variants can be listed, added, edited, disabled and removed through the core API; a removed variant keeps its results
- [ ] Writing a variant changes only its own llama-swap entry; round-trip tests on sample YAML keep hand-written entries and comments
- [ ] Models llama-swap already serves appear as variants that can be enabled
- [ ] The smoke test records load time, tokens per second and pass or fail, and a failed smoke test leaves the variant disabled with the reason
- [ ] Tests use a fake local server, never a real one
