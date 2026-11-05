---
title: Local-first runs with cloud escalation, and adding local models from Settings
epic: local-models
stage: tickets
blocked-by: []
---
Kiln sends almost every Ticket to a local model first, to find where local models really stop working, and lets Claude take over when local fails. Local models run through the Claude Code Agent pointed at the local model server (llama-swap in front of llama-server), so the OpenCode Agent goes. Settings gets an "Add a model" form that needs no AI: it recommends a local model's settings, writes the server's config entry and smoke-tests it. Every model + quant + settings combination is a **variant** with its own results, and Kiln picks variants by simple counting. A Project can also be local-only, with no cloud at all. Grilled 2026-11-05; the decisions are below. The spec is `spec.md`.

## Decisions (grill, 2026-11-05)

1. **OpenCode is removed.** The `widgets/opencode` Widget goes, with its mentions in the README, the glossary, ADRs 0004 and 0009, setup, the shell's wizard test, the test harness and the tracker issues. `.scratch/opencode-real-run/issues/01` becomes wontfix. The owner uses only Claude for now. A second cloud provider (to get under about $20 a month per plan) is left for later.
2. **Local models run through the Claude Code Agent.** A local variant starts Claude Code with the local server as its Anthropic base URL, its own empty config folder and no Anthropic login, the way the owner's claude-local script already runs it by hand. One Agent covers Claude and local models: one Policy, one set of trailer guards, one test suite. Fact to check first: that llama-swap passes Claude Code's Anthropic Messages requests (`/v1/messages`) through to llama-server.
3. **Cloud escalates on failure, plus a shadow sample.** Local runs first. When the Ticket's check fails (tests, Exit, a turn cap or a time cap), cloud takes over, seeded with the failed diff and the test output. About 1 in 5 Tickets that local *passed* also gets a cloud review against the Ticket's acceptance list. Cloud writes that list first when the Ticket has none.
4. **Settings → Add a model, with no AI.** Pick a GGUF file on disk, or a Hugging Face repo and quant. Kiln recommends context size, GPU layers, KV cache type and threads from the file size, the GGUF metadata and the GPU's free VRAM. The person adjusts them. Kiln writes the llama-swap entry, reloads llama-swap and runs a smoke test: the model loads, tokens per second, and it answers Claude Code's request format. A download asks first and shows the size. Each model + quant + settings combination is a **variant**.
5. **Kiln picks variants by counting.** Each role has a pool of variants:
   - A new variant gets the role's next Tickets until it has 5 results.
   - After that, the variant with the best pass rate for the role wins most Tickets, and about 1 in 5 goes to another variant so the scores stay current.
   - A variant that fails 3 Tickets of the same size in a row stops getting that size.
   - Ticket size comes from the diff size and files touched in past runs, or from the Ticket's estimate when there is no history.
   - A scoreboard shows each variant's pass rate, escalations and wall time, and why it ran. The person can pin a variant to override.
6. **Local-only mode:** a Project (or the whole install) that never uses the cloud. Escalation and the shadow sample are off.
7. **Each role is set in Settings:** "local first", "cloud only" or "local only". Implementer and reviewer start as local first; griller, spec-writer and ticket-writer start as cloud only. A local review never counts as the shadow sample's quality check.
8. **When local-only fails,** Kiln retries on up to 2 more variants, each seeded with the failure. It then runs the ticket-writer locally to propose splitting the Ticket and raises a blocking Ask showing the attempts. The person accepts the split, rewords the Ticket or parks it.
9. **When the GPU is busy,** local Sessions queue, one per GPU, through the GPU pool the GPU monitor Widget provides. In local-first mode a Ticket that has waited more than 30 minutes (adjustable) goes to cloud; local-only waits. Kiln never stops another program's GPU job, and never swaps in a smaller variant just because the GPU is busy. A smaller variant runs only when it is pinned.

## Comments
