---
title: Restart Kiln without losing running Sessions
epic: platform
stage: grill
blocked-by: []
---
Today every Session runs inside the Claude Code Widget, which the core starts, so restarting the core ends them all: their commits and Threads survive, but the turn in flight is lost and the Session has to start again. "Restart when idle" works around this by holding all new work until nothing runs, which on a busy night can mean hours of waiting with an empty queue. The person wants to restart Kiln whenever they need to (to load a merged change, or to reset a stuck app) and have the work simply carry on.

Two parts:

- **Pause after this turn**: a pause that lets each running Session finish its current turn and then stops it at that clean boundary, instead of interrupting mid-turn. Stop all, and a restart, use it.
- **Sessions survive a core restart**: on the way down, Kiln pauses every Session after its turn and records it; on the way up, it resumes each one from its Agent's saved conversation (Claude Code's own session id) in the same worktree, keeping its pool slot and its place. Up next keeps its order.

With both, "Restart" means: pause after the turn, restart, resume, and "Restart when idle" can go.

## To grill

- Agent processes that outlive the core (detached, reattached on boot) versus resume from the saved conversation: which, or both?
- How long "pause after this turn" may wait before it interrupts anyway.
- A Session paused at a blocking Ask: resumed as waiting, with its Ask still open?
- What the person sees: a "Restarting: 5 Sessions will resume" banner, and each Thread noting the pause and the resume.
- Local-model Sessions (llama-swap) and Project Thread Sessions: the same treatment?
- A failed resume: the Session ends with a note, and its Item goes back to Up next at the front?
- Widget updates (they restart only the Widget) should use the same pause and resume, so updating the Claude Code Widget stops cutting off Sessions too.
