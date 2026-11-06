# 02: Shell: step line and detail formatting (steps.ts)

**What to build:** Add packages/shell/src/work/steps.ts with stepLine(payload) and stepDetail(payload) following the spec's verb table (Read/Wrote/Edited/Ran/Searched/Listed/Started subagent/Fetched/web search/to-do, mcp__server__tool as 'server: tool', fallback name plus first string field; notes use first non-empty line, detail is full text). Read tool inputs defensively (strings only). Paths shown relative to item.run.worktree when inside it. Write/Edit show +N lines / -N/+M, never contents. Detail values cut at ~2,000 chars flagged for 'show all'. Plain unit tests in the Shell package.

**Blocked by:** None

**Status:** needs-triage
