# Spec: Local-first runs with cloud escalation, and adding local models from Settings

Status: ready-for-agent

Tickets: `.scratch/local-first/issues/01`–`12`. 01, 02, 04 and 05 can start now.

Sources: `.scratch/local-first/story.md` (the grill decisions of 2026-11-05), `docs/adr/0004-agents-are-widgets.md`, and the code as of branch `demo-project` (471308c).

## Problem Statement

Kiln runs every role on the model the setup wizard gave it. Nothing tries a cheaper model first.

- A machine with a capable GPU sits idle while every Ticket draws from the Claude plan. Nobody knows which Tickets a local model could do, because no Ticket is ever tried locally.
- The only route to local models is the OpenCode Agent (`widgets/opencode`). It has never run against a real OpenCode (`.scratch/opencode-real-run/issues/01`), and the owner doesn't use OpenCode.
- Adding a local model means editing the local server's config by hand, guessing context size and GPU layers, and then telling Kiln about it. Trying another quant or setting repeats all of it, which kills any experiment.
- Kiln records no results per model, so there is no evidence for choosing one model over another for a role.
- Someone who wants no cloud at all can't run Kiln that way: every role needs a cloud model.

## Solution

Kiln gets **local-first** roles. A local-first role runs its Ticket on a local model first. When the Ticket's check fails, Kiln hands the work to Claude with the failed diff and the test output. A sample of the Tickets local passed also gets a Claude review, so local work that passes the tests but is sloppy still shows up.

Local models run through the **Claude Code Agent**, pointed at the local model server, so OpenCode is removed. Settings gets **Add a model**, a form that needs no AI. It recommends a local model's settings, writes the server's entry, reloads the server and smoke-tests the model. Each model + quant + settings combination is a **variant**. Kiln records every variant's results on a scoreboard and picks variants by simple counting rules that the scoreboard explains. A Project, or the whole install, can be **local-only**.

## User Stories

### Adding a model

1. As the owner, I open Settings → Models → Add a model and pick a GGUF file on disk, or type a Hugging Face repo and pick a quant from its file list.
2. As the owner, Kiln shows recommended settings (context size, GPU layers, KV cache type, threads), each with a one-line reason such as "fits 22.1 of 24 GB at 64K". I can change any of them before saving.
3. As the owner, a Hugging Face download asks first and shows the file name and size. Nothing downloads until I confirm.
4. As the owner, saving writes the local server's config entry, reloads the server and runs a smoke test. I see whether it loaded, its tokens per second, and whether it answered a Claude Code request. A failed smoke test leaves the variant disabled, with the reason.
5. As the owner, I can add another variant of the same model (another quant, or another context size or KV cache type) without retyping the rest.
6. As the owner, I can disable or remove a variant. Removing it takes its entry out of the server's config; its results stay on the scoreboard, marked removed.
7. As the owner, a variant I added to the server's config by hand shows up in Settings as an existing variant that I can enable.

### Running local first

8. As the owner, each role in Settings is "local first", "cloud only" or "local only". Implementer and reviewer start as local first; griller, spec-writer and ticket-writer start as cloud only.
9. As the owner, a local-first Ticket runs on a local variant. Its Thread says which variant ran and why ("new variant, 2 of 5 results").
10. As the owner, when the local run fails its check (tests, Exit, the turn cap or the time cap), cloud takes over in a fresh Session, seeded with the failed diff and the test output. The Thread and the card show both attempts, with each one's cost and verdict.
11. As the owner, about 1 in 5 Tickets that local passed also gets a cloud review against the Ticket's acceptance list. When the Ticket has no acceptance list, cloud writes one first. The review's verdict is recorded against the variant.
12. As the owner, a local reviewer's verdict on a local implementer's work never counts as the shadow review.

### Local-only

13. As someone who wants no cloud, I can make a Project, or the whole install, local-only. No Session in it starts on a cloud model, and the wizard doesn't require a cloud Budget.
14. As someone running local-only, when a Ticket fails, Kiln retries it on up to 2 more variants, each seeded with the failure.
15. As someone running local-only, when every retry fails, Kiln runs the ticket-writer locally to propose a split into smaller Tickets and raises a blocking Ask with the attempts and the proposed split. I accept the split, reword the Ticket or park it.

### Choosing variants

16. As the owner, a new variant gets its role's next Tickets until it has 5 results.
17. As the owner, after that, the variant with the best pass rate for the role gets most Tickets, and about 1 in 5 goes to another variant so every score stays current.
18. As the owner, a variant that fails 3 Tickets of the same size in a row stops getting Tickets of that size. The scoreboard shows the cut-off.
19. As the owner, I can pin a variant to a role, or to one Ticket, and the rules step aside.
20. As the owner, the scoreboard shows each variant's pass rate per role and size, escalations, shadow verdicts, median wall time and tokens per second.

### A busy GPU

21. As the owner, only one local Session runs per GPU. The others wait in the queue, and their cards say they're waiting for the GPU.
22. As the owner, in local-first mode a Ticket that has waited more than 30 minutes (adjustable in Settings) goes to cloud instead. A local-only Ticket keeps waiting.
23. As the owner, Kiln never stops another program's GPU job, and never swaps in a smaller variant because the GPU is busy.

### OpenCode

24. As the owner, OpenCode is gone from Kiln: the Widget, the wizard and the docs. Nothing offers it.

## Implementation Decisions

### Removing OpenCode

- Delete `widgets/opencode/`. Remove it from `package-lock.json` (with `npm install`), the README's Widget list, `GLOSSARY.md`, and the setup code and wizard test that name it (`packages/core/src/setup/setup.ts`, `packages/shell/test/setup-wizard.test.ts`, `packages/testing/src/harness.ts`).
- Write a short ADR that amends ADRs 0004 and 0009: local models run through the Claude Code Agent. Leave the older ADRs as written.
- `.scratch/opencode-real-run/issues/01` becomes wontfix, with a pointer to this spec. Older tracker files that mention OpenCode stay as they are (they are history). `.scratch/pi-agent-widget` is unaffected.

### Local models through the Claude Code Agent

- A local variant's Session starts Claude Code with `ANTHROPIC_BASE_URL` set to the local server, a fresh per-Session `CLAUDE_CONFIG_DIR` under the Widget's data folder, no Anthropic credential in its environment, and the variant's model id as the model. The environment Claude Code gets today (`claudeEnv()` in `widgets/claude-code/src/agent.ts`) is filtered further for local Sessions, so no Anthropic key or login reaches them.
- The Policy, the Kiln MCP tools, the no-attribution settings and the trailer checks are the same as for a cloud Session.
- First Ticket's fact check: llama-swap passes `POST /v1/messages` through to llama-server, and Claude Code's tool calls come back in Anthropic shape. If they don't, a small shim inside the Widget translates. The check runs only while the GPU is free.
- Usage: a local turn costs one turn against the local Budget (`packages/core/src/budgets/local.ts`, unchanged). The variant id is recorded on every usage record.

### Variants and Add a model

- A **variant** is a core record: id, display name, server model id, the GGUF file (path, size, quant), settings (context size, GPU layers, KV cache type, threads, extra flags), state (enabled, disabled with a reason, or removed) and the last smoke test.
- The local server integration sits behind one interface, with llama-swap as the first implementation: list models, read and write an entry in its YAML config, reload, and send a test request. The config path is a Setting, never a hard-coded folder.
- Recommendations come from plain arithmetic, with no model call:
  - weights size from the file;
  - KV cache size per token from the GGUF metadata (layers, KV heads, head size) and the KV cache type;
  - free VRAM from the GPU monitor Widget.
  Kiln picks the largest context from 16K, 32K, 64K, 128K and so on that leaves 1.5 GB headroom, with all layers on the GPU. When even 16K doesn't fit, it offloads layers. Each recommendation shows its numbers.
- The smoke test loads the model, sends one short Anthropic Messages request that asks for a tool call, and records load time, tokens per second and pass or fail.
- A Hugging Face download uses the public HTTP API and resumes. It asks first, with the size shown. Files go to a models folder set in Settings.

### Routing and escalation

- A role's mode (local first, cloud only, local only) lives in the Workflow's role settings next to the existing `model` and `fallbackModel`. The per-Project local-only switch lives in `.kiln/settings.json`; the install-wide one is a core setting.
- The variant picker is a pure function of the scoreboard and the Ticket, which makes it easy to test:
  - a new variant (fewer than 5 results for the role) goes first;
  - otherwise the best pass rate for the role and size wins, with 1 in 5 Tickets exploring another variant;
  - a variant on a run of 3 failures for a size is skipped for that size.
  It returns the variant and a reason string that the Thread shows.
- Ticket size: small, medium or large, from the diff lines and files touched in the Item's earlier runs, else the Ticket's estimate, else medium. The thresholds are written in the module.
- Escalation is a fresh Session on the role's cloud model, seeded with the failed diff, the failed check's output and the local variant's name. It is one Stage attempt: the Item doesn't move back.
- The shadow sample: each passed local Ticket has a 1 in 5 chance, decided when the local run passes. The shadow review runs a cloud reviewer against the acceptance list, writing the list first when the Ticket has none. Its verdict goes on the variant's record and doesn't block the Item.
- Local-only failure: the picker gives the next 2 variants in order, each seeded with the failures so far. After that, a local ticket-writer proposes a split and Kiln raises a blocking Ask with Accept split, Reword and Park.

### The GPU queue

- Local Sessions take the local Budget's pool slot (`LOCAL_POOL`) and the GPU monitor Widget's `gpu` pool, one slot per GPU. Waiting Sessions queue in arrival order.
- The 30-minute cutoff is a Setting. When it passes on a local-first Ticket, Kiln hands the Ticket to cloud as if local had failed, recorded as "GPU busy", which doesn't count against the variant.

### Settings and the scoreboard (shell)

- Settings → Models: the variant list, Add a model, and the role modes.
- Scoreboard: one row per variant, filterable by role and size, showing every number the picker uses.

## Testing Decisions

- Only `@kiln/testing` drives Kiln in tests, as everywhere else.
- **The variant picker:** unit tests on fixed scoreboards (a new variant first, the best rate wins, 1 in 5 exploration with a seeded random source, the 3-in-a-row cut-off per size, a pin overrides).
- **Recommendations:** unit tests on fixed GGUF metadata and VRAM figures (fits fully, fits only a smaller context, needs offload). Each test asserts the numbers shown alongside the recommendation.
- **The llama-swap config writer:** round-trip tests on sample YAML. Entries added by hand and comments survive, and only the variant's own entry changes.
- **Escalation and the shadow sample:** harness tests with a fake local server and the fake Claude SDK. A failing local turn escalates to cloud with the diff in the seed. A seeded shadow pick runs a cloud review. A local-only failure retries 2 variants and then raises the split Ask.
- **No Anthropic credential reaches a local Session:** a test checks the fake SDK's logged environment and options.
- **GPU queue:** a second local Session waits for the pool slot, and a short cutoff in the test sends the waiting Ticket to cloud as "GPU busy".
- The real llama-swap check (decision 2) is a gated test, like the old real OpenCode suite, run by hand with the GPU free.

## Out of Scope

- A second cloud provider, and any metered provider other than Claude.
- Building or managing llama-swap or llama-server themselves. Kiln writes an entry and reloads the server; it doesn't install or upgrade them.
- Automatic quantisation or GGUF conversion.
- Choosing variants with anything smarter than counting (bandits, learned routing).
- Running local Sessions on another machine's GPU.

## Further Notes

- The owner's break-even study (Haiku first, then Sonnet when a scripted check fails) passed 15 of 18 replayed Tickets at about a tenth of Opus's cost. It is why this spec relies on escalation instead of a smarter first pick.
- Suggested Ticket order: OpenCode removal and the llama-swap fact check first (they're independent), then variants and Add a model, then routing and escalation, then the shadow sample, local-only and the GPU queue.
