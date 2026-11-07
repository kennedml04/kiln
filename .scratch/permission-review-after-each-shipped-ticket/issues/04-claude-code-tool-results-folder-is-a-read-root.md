# 04: Claude Code tool-results folder is a read root

**What to build:** Spec section 4, in widgets/claude-code (src/permissions.ts). First reproduce why Asks to read tool-results files still came after ownFolderOf (f07e4a3): hook without transcript_path, subagent transcript elsewhere, Git Bash /c/Users/... spelling or case; fix the cause. Then make every folder named exactly tool-results under <config>/projects/ (CLAUDE_CONFIG_DIR or ~/.claude) a read-only root: read tools and read-only shell commands under it are worktree_read, writes stay outside_worktree, transcripts beside it stay outside_worktree. Follows the SCRATCH rule for Stages that deny outside_worktree. The folder is computed at run time and never written into a rule or commit. Tests in widgets/claude-code/test: requestFor Read of <config>/projects/x/y/tool-results/abc.txt without ownFolder is worktree_read; Bash cat/head -50 is a read; Write there is outside_worktree; <config>/projects/x/y.jsonl still outside_worktree; Windows, Git Bash and posix spellings; CLAUDE_CONFIG_DIR set.

**Blocked by:** None

**Status:** needs-triage
