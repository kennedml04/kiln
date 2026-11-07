# 01: Refuse "Always allow" when the match names an absolute path

**What to build:** Add exported namesAbsolutePath(match) in packages/widget-sdk/src/rule-patterns.ts (words starting with drive letter+slash, a leading /, or ~; /dev/null exempt; true whenever LOCAL_PATH matches; relative paths, URLs and env-var paths not counted). alwaysAllowMatch returns undefined when it is true, in place of the LOCAL_PATH test, so the Session Manager offer and groupByRule follow. Tests: table-style unit tests in packages/core/test/rule-patterns.test.ts (absolute and not-absolute cases, git log C:/x still saves git log *, groupByRule leaves out /tmp asks); via startTestKiln + fake Agent, cat /tmp/x.txt raises an Ask without Always allow and Allow once runs it; a cd "<own worktree under .../Users/someone/...>" && git status raises no Ask (regression).

**Blocked by:** None

**Status:** needs-triage
