# 22: Claude Code Agent Widget

**What to build:** A first-party Agent Widget that runs Sessions with Claude Code through the Claude Agent SDK, behind the same Agent interface as the fake Agent:

- It starts Sessions with the given role, model, seed, worktree and Kiln tools endpoint.
- It translates Kiln's effective Policy into Claude Code permission settings, and turns Claude Code's permission prompts into Kiln permission requests through a permission callback.
- It reports usage per turn, including subagents with their descriptions.
- It reports the Max plan quota readings by polling the SDK's experimental usage method, as `docs/research/claude-code-quota-readings.md` describes. It reports at the start and end of each Session and at a modest interval, normalising units, with rate-limit events as the fallback for the weekly window. It also reports the prompt-cache lifetime for the model in use.
- It supports message, interrupt, resume and stop.

No Claude Code hooks, session IDs or settings files leak into the core. The Agent contract suite (shared with the fake Agent) runs against it as an opt-in suite outside default CI, using the cheapest model, a tiny scripted task and a hard cap of a few cents.

**Blocked by:** 03, 10, 12, 15

**Status:** resolved

- [ ] A real Ticket runs through Implementing with Claude Code in its worktree and passes the Exit check
- [ ] An "ask" action in the Policy produces a Kiln Permission Ask, and a deny is honoured by Claude Code
- [ ] Per-turn usage and subagent usage reach Kiln's records
- [ ] Quota readings reach Kiln when available; if they're unavailable, the subscription Budget shows "unknown"
- [ ] Sessions use the Kiln tools (Asks, Item content, Digest)
- [ ] The opt-in contract suite passes within its cost cap
- [ ] The core has no Claude Code-specific code
