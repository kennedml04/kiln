# 02: Widget SDK: resume token, SessionStart.resume, pause_after_turn

**What to build:** In packages/widget-sdk/src/agent.ts add the resume_token Agent event, optional SessionStart.resume {token, message, permission?}, the agent.pause_after_turn command / pauseAfterTurn method, and the 'paused' FinishReason (core falls back to interrupt for Agents without it). Implement in the fake Agent (reports a token, accepts resume, logs it, pauseAfterTurn, scripted resume failures) and in the Claude Code Widget (SDK query with resume in the same cwd, pre-allow the exact permission action once). Core persists the token as soon as the event arrives.

**Blocked by:** None

**Status:** in-review

**Stage:** review
