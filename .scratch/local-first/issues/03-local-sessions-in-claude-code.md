# 03: Local Sessions in the Claude Code Agent

**What to build:** The Claude Code Agent runs a Session on a local model when its model is a local variant. That Session starts Claude Code with:
- `ANTHROPIC_BASE_URL` set to the local server;
- a fresh per-Session `CLAUDE_CONFIG_DIR` under the Widget's data folder;
- no Anthropic key, token or login in its environment (`claudeEnv()` in `widgets/claude-code/src/agent.ts` filters them for local Sessions);
- the variant's server model id as the model.

The Policy, the Kiln MCP tools, the no-attribution settings and the trailer checks stay exactly as for a cloud Session. Add the shim from 02 if it is needed. Usage goes to the local Budget at one turn per turn, with the variant id on each record. See "Local models through the Claude Code Agent" in `spec.md`.

**Blocked by:** 02, 04

**Status:** in-review

**Stage:** implementing

- [ ] A Session whose model is a local variant reaches the local server, not Anthropic (fake SDK test on the logged options and environment)
- [ ] No Anthropic credential or config folder reaches a local Session
- [ ] The Policy, Permission Asks and attribution settings are the same as for a cloud Session (contract suite unchanged)
- [ ] Usage records carry the variant id and draw on the local Budget
- [ ] The gated real test from 02 passes through the Widget
