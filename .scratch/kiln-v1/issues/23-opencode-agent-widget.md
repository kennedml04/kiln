# 23: OpenCode Agent Widget

**What to build:** A first-party Agent Widget that runs Sessions with OpenCode through its SDK, behind the same Agent interface. It maps Kiln's effective Policy to OpenCode's permission configuration and turns OpenCode permission prompts into Kiln permission requests. It reports usage per turn, including subagents, with cost in the Budget's unit. It uses the Kiln tools. It serves two kinds of Budget: the metered work Budget (OpenCode's configured provider), and local Budgets (OpenCode pointed at a local OpenAI-compatible model server). Any Claude-only assumption that shows up in the Agent interface while building this gets fixed in the interface, not worked around. The Agent contract suite runs against it opt-in, with a hard cost cap; local runs cost nothing.

**Blocked by:** 10, 12, 15, 18

**Status:** resolved

- [ ] A real Ticket runs through Implementing with OpenCode and passes the Exit check
- [ ] The Policy translation and Permission Asks behave exactly as they do for the Claude Code Widget
- [ ] Usage reaches Kiln for metered and local models, each against its own Budget
- [ ] Pointing at a local model server runs a Session on the local Budget
- [ ] The shared Agent contract suite passes, unchanged, against this Widget

## Comments

2026-11-03: The Widget is built and merged, and its scripted tests pass. The gated real run moved to `.scratch/opencode-real-run/issues/01-verify-opencode-widget-against-real-opencode.md`, because it needs a machine with OpenCode installed.
