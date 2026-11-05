# 05: Module skills and MCP servers reach Sessions

**What to build:** The Claude Code Agent gives each Session the skills and MCP servers of its Project's modules, and nothing from other modules.
- Skills are copied into the Session's own config folder, never into the repo. Only skill folders load, never settings or hooks, matching `.scratch/skill-and-widget-repos/issues/05`.
- Until Skill repos land, a module's skills come from skill folders inside the module itself. Write the loading code so issue 05 there can reuse it.
- MCP servers from `mcpServers` are added to the Session's options. Their tool calls go through the Session's Policy like any other tool.
- A module whose `needs.widgets` aren't installed is a Project error that names the missing Widget.

User stories 12 and 15 in `spec.md`.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A Session in a Project with a module gets that module's skills and MCP servers; a Project without it gets neither (fake SDK test on the logged options)
- [ ] No skill files are written into the repo or worktree
- [ ] MCP tool calls are subject to the Session's Policy
- [ ] A missing needed Widget shows as a Project error
