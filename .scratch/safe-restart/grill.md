# Grill: Restart Kiln without losing running Sessions

Grilled 2026-11-05. Each answer below is the person's, given through a Kiln Ask.

## Context found in the code

- `packages/core/src/operations/restart.ts` is "Restart when idle". It holds new Sessions until
  none run, then restarts. The scheduler matches its "waiting to restart" wording to keep Up next
  entries in place.
- `packages/core/src/flow/session-manager.ts`: Stop all already *interrupts* Sessions into
  `paused`, and `resume()` continues them while the Agent's cache is warm. All of this is in memory
  (`live`), so nothing survives a core restart.
- `widgets/claude-code/src/agent.ts`: one streaming SDK `query` per Session. Claude Code's session
  id stays inside the Widget, and `resume` after an interrupt sends "Kiln paused you; carry on where
  you left off."
- Local-model Sessions run through the same Claude Code Widget against llama-swap. llama-swap is
  external and survives a core restart.

## Decisions

1. **Resume from the saved conversation only.** No detached Agent processes and no reattach. The
   Widget hands the core an **opaque resume token** (Claude Code's session id). The core persists
   it against the Kiln Session and hands it back on resume, which starts the SDK with `resume` in
   the same cwd/worktree.
2. **Pause after this turn waits up to 10 minutes** (a setting), then interrupts any Session still
   running. An interrupted Session resumes with "carry on where you left off" and loses only the
   partial turn. The banner has **Restart now**, which interrupts at once.
3. **Sessions waiting on an Ask** keep their Ask open across the restart and stay `waiting`.
   When the Ask is answered, Kiln resumes the conversation. For a **Permission Ask**, the decision
   is passed in on resume ("your <action> was allowed/denied"). On allow, that exact action is
   pre-allowed once, so the retried tool call doesn't ask again.
4. **What the person sees**:
   - A Shell-wide banner: "Restarting: waiting for 3 of 5 Sessions to finish their turn (9:12
     left) [Restart now] [Cancel]". Cancel works until the core actually goes down.
   - "Kiln is restarting…" while the core is down. The Shell reconnects and doesn't show a broken
     board.
   - Afterwards: "5 Sessions resumed", or "4 resumed, 1 failed" with links to the failed Threads.
   - Two system notes in each affected Thread: "Paused for a Kiln restart after this turn" and
     "Resumed after the restart".
5. **Local-model and Project Thread Sessions get the same treatment.** A local Session's attempt
   (its Variant/model) is persisted and the Session resumes on the same Variant, never re-routed.
   If the Variant is gone, the resume counts as failed (see 6). Project Thread Sessions resume in
   their data-folder cwd.
6. **Failed resume**: one retry. If that fails too, the Session ends with a Thread note saying why.
   Its commits and worktree are kept, and its Item goes back to the **front** of Up next. The next
   Session starts fresh from Digests. Up next otherwise keeps its order, and resumed Sessions keep
   their pool slots.
7. **Widget updates use the same pause and resume**, scoped to that Widget's Sessions only, with
   the same limit, Restart now and Cancel. The scheduler holds new Sessions for the updating Widget
   only. Because the resume token is opaque and stored by the core, a new Widget version can take
   it back.
8. **Stop all** now pauses after the turn. A new **Stop now** interrupts at once. Both leave
   Sessions paused and resumable.
9. **"Restart when idle" is removed.** The Shell's Restart and `kiln restart` become the safe
   Restart (pause after the turn, restart, resume), and `kiln restart --now` skips the wait. The
   scheduler's Up next hold moves from the old wording to the new restart.
10. **Crash and reboot recovery.** The resume token is persisted as soon as a Session starts. After
    an unplanned stop, Sessions that were running are resumed on the next boot with "carry on where
    you left off" and the note "Resumed after Kiln stopped unexpectedly". A Session gets **at most
    one crash-resume**. After that it goes through the failed-resume path (6), so a Session that
    crashes the core can't loop.

## Implications for the build

- Persist Session state the core keeps only in memory today: state, resume token, pool slot,
  local attempt, `interrupted`, pending Permission decision, crash-resume count.
- Widget SDK: the Agent reports its resume token (an event or a field on the start result), and
  `SessionStart` takes an optional resume token. The fake Agent needs to support both for tests.
- The current Stop all resume checks whether the cache is still warm (`cacheWarm`). For a restart
  resume, the token is the basis whether or not the cache is warm, since a resume is cheap after a
  seconds-long restart. A cold-cache resume just costs more.

## Still open

- No questions for the person are left. Exact wording of the banner and notes, and the name of the
  setting for the 10-minute limit, are up to the implementer.
