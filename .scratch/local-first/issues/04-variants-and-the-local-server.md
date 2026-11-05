# 04: Variant records and the local server interface

**What to build:** A core record for each **variant**: id, display name, server model id, GGUF file (path, size, quant), settings (context size, GPU layers, KV cache type, threads, extra flags), state (enabled, disabled with a reason, removed) and the last smoke test. Add one local-server interface (list models, read and write one entry in its config, reload, send a test request) with llama-swap as its first implementation. The llama-swap config path is a Setting, never a hard-coded folder. Entries written by hand and comments in the YAML survive Kiln's edits. Models the server already lists show up as variants that can be enabled. The smoke test loads the model, sends one short Anthropic Messages request that asks for a tool call, and records load time, tokens per second and pass or fail. API only; the Settings page is 06. See "Variants and Add a model" in `spec.md`.

**Blocked by:** None

**Status:** resolved

- [x] Variants can be listed, added, edited, disabled and removed through the core API; a removed variant keeps its results
- [x] Writing a variant changes only its own llama-swap entry; round-trip tests on sample YAML keep hand-written entries and comments
- [x] Models llama-swap already serves appear as variants that can be enabled
- [x] The smoke test records load time, tokens per second and pass or fail, and a failed smoke test leaves the variant disabled with the reason
- [x] Tests use a fake local server, never a real one

**As built:** The API types are in `packages/widget-sdk/src/variants.ts` (`Variant`, `VariantList`, `LocalServerSettings`, `SmokeTestResult`, the request bodies and the `variant.updated` event). The core part is `packages/core/src/local/`. `variants.ts` holds the records (a new `variants` table; removed rows stay), the `local-server` Setting (config path, URL, server command and timeouts, none of them assumed) and the found entries. `local-server.ts` is the server interface, and `llama-swap.ts` is its llama-swap implementation. `llama-swap-config.ts` edits the YAML by splicing the source text: only the variant's own entry changes, and the result is parsed again and checked against every other entry. It also turns settings into llama-server flags and reads hand-written command lines back. `smoke-test.ts` sends a one-token load request, then a `read_file` tool-call request. `routes.ts` serves `/api/local-server` and `/api/variants`. Changes are Admin-only (`access.ts`). The new dependency is `yaml`, in core and testing. Reload means waiting for llama-swap's `GET /v1/models` to show the change (it has to run with `--watch-config`), then unloading that one model. Tests: `packages/core/test/variants.test.ts`, against the fake llama-swap in `packages/testing/src/fake-local-server.ts` (`@kiln/testing/fake-local-server`).
