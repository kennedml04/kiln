# 04: Pi Kiln MCP tools and Policy hook

**What to build:** Give Pi Sessions Kiln's tools via createMcpExtension() pointed at the Session's Kiln tools URL with exposure "direct". Add Pi's tool_call hook that sorts each call into a Kiln action using the shared classifier (bash via classifier, edits/writes as file actions checked against the worktree path, unknown tools default to Ask). While an Ask is open the hook holds the call; on Deny return {block: true, reason}. Needs the classifier move and the Widget skeleton.

**Blocked by:** None

**Status:** needs-triage
