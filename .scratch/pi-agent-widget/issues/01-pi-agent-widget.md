# 01: Pi Agent Widget

**What to build:** A first-party Agent Widget that runs Sessions with the Pi coding agent, behind the same Agent interface as the Claude Code and OpenCode Widgets. Pi becomes one more Agent beside them, chosen per Stage, so the person can try it on real Tickets and compare Digests, cost and Exit pass rates before deciding whether to switch. Facts about Pi, each with a source link: `docs/research/pi-coding-agent.md` (Pi 1.5.0, 2026-11-02).

Any Claude- or OpenCode-only assumption that shows up in the Agent interface gets fixed in the interface, not worked around.

Decisions (grilled 2026-11-03):

1. **Role.** Pi runs side by side with the other Agents, chosen per Stage in the Workflow or Project settings. It is not the default Agent.
2. **Driving Pi.** The Widget runs Pi's SDK (`createAgentSession()` from `@earendil-works/pi-coding-agent`) inside its own process. That process is the Widget process, separate from the core (ADR 0007). The exact Pi version is pinned in the Widget's `package.json`, because Pi's minor releases can break things. A newer Pi ships by changing the pin and releasing it through the normal Widget update, with the contract suite as the gate. It does not use `pi --mode rpc` or a globally installed `pi`.
3. **Models and Budgets.** Pi Sessions run on local Budgets (OpenAI-compatible local servers such as LM Studio) or on a metered Budget backed by an API key, which is held as a Widget secret. It has no Claude Pro/Max or other subscription login for now.
4. **Kiln tools.** Pi gets them from Kiln's existing MCP endpoint, the same one the other Agents use. The Widget adds Pi's `createMcpExtension()` pointed at the Session's Kiln tools URL, with `exposure: "direct"`, so the model calls the tools by name.
5. **Isolation.** A Session loads only what Kiln sets up: the role prompt, the model, the Kiln MCP extension, the Policy hook, and the local providers taken from Kiln's own Budgets. The worktree's `AGENTS.md` and `CLAUDE.md` load as usual. It loads none of the person's user-level Pi extensions, skills, settings or `models.json`.
6. **Prompt cache.** Pi's keep-warm refresh is turned off. The Widget reports the model's prompt-cache lifetime from Pi's own table, and Kiln's pause, resume and expiry handle the timing.
7. **Compaction.** Pi's auto-compaction stays on. The Widget reports the model's `contextWindow` and the context tokens of every turn, so the runaway guard has real numbers. Each compaction shows in the Thread as a progress event, for example "Pi compacted context: 41k → 9k tokens".
8. **Session controls.**
   - **message:** sent as a steer while Pi is running, and as a follow-up when it is idle.
   - **interrupt:** aborts the run. Any tool call held on an open Ask is cancelled, and that Ask closes as "no longer needed".
   - **resume:** reopens the Pi session file. The Widget keeps that file in its own data folder, keyed by the Kiln Session id.
   - **stop:** aborts the run and closes the session. The file stays until Kiln cleans up the Session.
   - **finished:** Kiln treats a run as finished only on Pi's `agent_settled` event, not on `agent_end`.
9. **Policy.** The Claude Code Widget's command classifier (`widgets/claude-code/src/permissions.ts`) moves into `@kiln/widget-sdk`. The Claude Code and Pi Widgets both use it, and OpenCode can switch to it later. Pi's `tool_call` hook sorts every call into a Kiln action:
   - bash `{command}` goes through the classifier;
   - edits and writes `{path, ...}` map to file actions, checked against the worktree path;
   - a tool the Widget doesn't recognise defaults to Ask.
   While an Ask is open the hook holds the call. On Deny it returns `{block: true, reason}`.
10. **Usage.** Usage is reported per turn: input, output, cache-read and cache-write tokens, the model, and the cost in the Budget's unit. A local model reports no cost. Pi has no built-in subagents, so there is no subagent usage to report.
11. **Testing.** The shared Agent contract suite runs against this Widget opt-in. One run uses a free local LM Studio model on a local Budget, and another uses a metered model with a hard cost cap. Neither runs by default.

**Blocked by:** None. It builds on the shipped Agent interface and contract suite (kiln-v1 22 and 23). Kiln must pick the Agent whose registration offers the Stage's model; that is code-review fix W1 on kiln-v1.

**Status:** ready-for-agent

- [ ] A real Ticket runs through Implementing with Pi in its worktree and passes the Exit check, on a local model and on a metered model
- [ ] An "ask" action in the Policy produces a Kiln Permission Ask that holds the tool call, and a deny is honoured by Pi
- [ ] The command classifier lives in `@kiln/widget-sdk`, and the Claude Code and Pi Widgets give the same Policy action for the same command
- [ ] A Pi tool the Widget doesn't recognise raises an Ask
- [ ] The person's user-level Pi extensions, skills, settings and `models.json` don't load into a Session
- [ ] Per-turn usage, `contextWindow` and cache lifetime reach Kiln, against the model's own Budget, with no cost for a local model
- [ ] Message steers a running Session, and interrupt, resume and stop behave as described above
- [ ] A compaction shows in the Thread
- [ ] The shared Agent contract suite passes, unchanged, against this Widget
