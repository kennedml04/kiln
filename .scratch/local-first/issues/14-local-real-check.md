# 14: A real check for local Agents

**What to build:** The real test for a local model, judged by outcomes rather than by the shared Agent contract's exact steps. A local model looks around first (`ls -la`) whatever the Ticket says, so the contract's "the first Ask is the refused command" can never hold. The check, gated by `KILN_REAL_LOCAL=1` in `widgets/claude-code/test/local-session.test.ts`, runs a small Ticket through the Claude Code Widget on a local variant and passes when:
- the Ticket's Exit is met;
- every turn is on the local Budget under the variant id, with no dollar figure;
- a command the Policy refuses never runs (it may be asked for; it must be refused and not executed);
- no request leaves for Anthropic.

Read-only commands are known to the Project; any other Ask is allowed once. On failure the test prints the audit trail and the Session's state, so a slow model can be told from one going round in circles.

Ticket 03's "Open" note has the four real runs so far (`qwen-27b` at 64K behind llama-swap: wiring works, every run timed out; the last one after the usage fix stayed at 15 to 16K context and still hit 15 minutes). Before a real run, check that the GPU is free; unload the model afterwards.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The gated check judges outcomes only: Exit met, local Budget charged under the variant id, refused command not run, no Anthropic request (fake-backed test of the check's own pass and fail cases)
- [ ] A failing real run prints the audit trail and the Session's state
- [ ] One real run on a local variant passes, or the ticket records why not with the run's audit trail
