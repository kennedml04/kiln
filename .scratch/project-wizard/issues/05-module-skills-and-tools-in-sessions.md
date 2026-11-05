# 05: Module skills and MCP servers reach Sessions

**What to build:** The Claude Code Agent gives each Session the skills and MCP servers of its Project's modules, and nothing from other modules.
- Skills are copied into the Session's own config folder, never into the repo. Only skill folders load, never settings or hooks, matching `.scratch/skill-and-widget-repos/issues/05`.
- Until Skill repos land, a module's skills come from skill folders inside the module itself. Write the loading code so issue 05 there can reuse it.
- MCP servers from `mcpServers` are added to the Session's options. Their tool calls go through the Session's Policy like any other tool.
- A module whose `needs.widgets` aren't installed is a Project error that names the missing Widget.

User stories 12 and 15 in `spec.md`.

**Blocked by:** 03

**Status:** done

- [x] A Session in a Project with a module gets that module's skills and MCP servers; a Project without it gets neither (fake SDK test on the logged options)
- [x] No skill files are written into the repo or worktree
- [x] MCP tool calls are subject to the Session's Policy
- [x] A missing needed Widget shows as a Project error

Built (2026-11-05):
- The core puts `skills` (`{ name, source, commit, folder }`, as skill-and-widget-repos 04 decides) and `mcpServers` in `SessionStart` (`packages/widget-sdk/src/agent.ts`). `packages/core/src/work/skills.ts` finds them: `skillFolders(folder)` reads any folder of `<name>/SKILL.md` folders, for Project skills and Skill repos to reuse. A module keeps its skills in `skills/<name>/SKILL.md`.
- The Claude Code Widget copies the skill folders into a `kiln-skills` local plugin in `<widget data>/session-config/<session>/` (`widgets/claude-code/src/skills.ts`), with `skipMcpDiscovery`, and removes it when the Session stops. `settingSources` stays `[]`.
- A module MCP tool call (`mcp__<server>__<tool>`) is checked as `other_commands` with the detail `<tool> <input JSON>`, so a rule like `mcp__printer__slice *` can allow one tool. Reading the Session's own skill copies and the `Skill` tool need no decision.
- Project errors, on the module's `modules[i]` entry: a needed Widget not installed (re-checked when a Widget is installed or removed), a listed skill with no folder, a server named `kiln`.
