# Grill: A clear "Your move" cue when the person must start the next Stage

Story: `.scratch/your-move-cue/story.md` (Epic: board-ux). Grilled 2026-11-06, one Ask per question.

## What the code already does

Kiln already starts the next Stage by itself. When an Item enters a Stage that runs a Session (its Exit was met, a merge moved it, or a Gate sent it back), the Scheduler queues it on `item.stage_changed` / `item.rework` with no Start press (`packages/core/src/flow/scheduler.ts`, `admit`). In the first Live demo run, the Item sat at Spec / backlog because that start failed after the hand fix of the stuck worktree. The failure was published as `scheduler.start_failed`, and nothing in the Shell shows that event. So the gap is a silent failed start, not a missing auto-start.

## Decisions

1. **Auto-start stays everywhere. The cue is only for stuck Items.** There is no per-Stage "start by hand" setting and no deliberate "waiting for Start" state. The cue appears only when an Item is stuck.
2. **What "stuck" means.** An Item is stuck when it is in a Stage that runs a Session and has no running Session, no Up next entry and no open Ask, **and** Kiln moved it into that Stage or tried to start it: a `scheduler.start_failed` after an Exit, a merge, a rework, a Start press or a re-queue. Items a person placed in Backlog on purpose (for example a new Story added by hand) are not stuck and get no cue.
3. **Surfaces.** The cue shows in three places:
   - **Card badge** "Your move: Start", with the failure reason on hover or tap.
   - **Needs you entry** with the reason and a **Start** (retry) button.
   - **Thread message**, one per failed start, giving why the start failed.
   There is no separate browser or phone notification.
4. **How it clears.** Only from the Item's state, with no Dismiss. The cue goes away as soon as the Item is no longer stuck: a Session starts, it joins Up next, it changes Stage, it ships, or it is archived. Pressing Start clears it only if the start works. If the start fails again, the cue stays and shows the new reason. To park an Item on purpose, the person moves it to a Stage that runs no Session, or archives it.

## Implied behaviour

- While Stop all is on, queued Items are in Up next, so they are not stuck and show no cue.
- An Item waiting on an Ask or a Gate is not stuck. Its Ask is already in Needs you.
- The reason shown is the `start_failed` error, put into plain words where it is a known case (Agent not ready, pool missing, worktree in the way).

## Still open (for the Spec)

- Where the stuck state lives: worked out from events on the fly, or a stored `start_failed` mark per Item that is cleared on the next state change. The stored mark is the likely choice, so the cue survives a core restart.
- Whether the Needs you entry is a new kind of entry or a system-raised Ask. Decision 4 needs it to clear by itself, so a plain Ask would need auto-resolve.
- What an Item stuck from before this ships looks like. Today's Items have no `start_failed` record, so they may need a one-off check at startup.
- Whether the Thread message goes to the Item's Thread, the Project Thread, or both.
- Glossary: add "Your move" / "Stuck" to `GLOSSARY.md` when the first Ticket uses them.
