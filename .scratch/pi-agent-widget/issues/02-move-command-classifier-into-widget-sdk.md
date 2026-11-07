# 02: Move command classifier into widget-sdk

**What to build:** Move the Claude Code Widget's command classifier (widgets/claude-code/src/permissions.ts) into @kiln/widget-sdk, and switch the Claude Code Widget to use it. Behaviour of Claude Code must not change; its existing tests keep passing. Also fix any Claude/OpenCode-only assumption found in the Agent interface in the interface itself.

**Blocked by:** None

**Status:** done

**Stage:** shipped
