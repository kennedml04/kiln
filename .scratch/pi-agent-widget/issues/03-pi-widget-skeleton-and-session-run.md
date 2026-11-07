# 03: Pi Widget skeleton and Session run

**What to build:** Create widgets/pi: a first-party Agent Widget with Pi pinned in package.json, driving Pi via createAgentSession() from @earendil-works/pi-coding-agent in the Widget process. Registers as an Agent chosen per Stage (not default); runs a Session in its worktree with the role prompt and model, loading worktree AGENTS.md/CLAUDE.md but none of the person's user-level Pi extensions, skills, settings or models.json. Local providers come from Kiln's Budgets; metered Budgets use an API key held as a Widget secret. Treats a run as finished only on agent_settled. Ensure Kiln picks the Agent whose registration offers the Stage's model (kiln-v1 fix W1) if not already done.

**Blocked by:** None

**Status:** in-review

**Stage:** review
