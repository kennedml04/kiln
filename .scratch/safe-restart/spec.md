# Spec: Restart Kiln without losing running Sessions

Status: ready-for-agent

Sources: `.scratch/safe-restart/story.md`, the grill record `.scratch/safe-restart/grill.md` (2026-11-05, every decision the person's), and the code on `kiln/story/safe-restart` (0d6bed4).

## Problem Statement

- Every Session runs inside an Agent Widget that the core starts, so a core restart ends them all. On boot, `session-manager.ts` marks every `running`, `paused` or `waiting` Session `stopped` ("their Agent processes are gone"). Commits and Threads survive, but the turn in flight is lost and the Item starts again in a fresh Session.
- "Restart when idle" (`packages/core/src/operations/restart.ts`) works around this by holding every new Session until none run. On a busy night that is hours of waiting with an empty queue.
- Stop all already interrupts Sessions into `paused`, and `resume()` continues them while the cache is warm, but this state lives only in memory (`live`). Claude Code's own session id stays inside the Claude Code Widget, so the core can't hand it back.
- Updating a Widget restarts only that Widget, but for the Claude Code Widget that still cuts off every Session it runs.
- After a crash or a reboot, Sessions that were running are lost in the same way.

## Solution

Two building blocks, used by every stop and restart:

- **Pause after this turn**: each running Session finishes its current turn and stops at that clean boundary. After a limit (10 minutes by default, a setting) any Session still running is interrupted.
- **Resume from the saved conversation**: the Agent Widget reports an opaque **resume token** (Claude Code's session id) when a Session starts. The core persists it, together with the rest of the Session's state. After a restart, the core starts the Session again with that token, in the same worktree, on the same Agent and model, in the same pool slot.

With both, **Restart** means: pause after the turn, restart the core, resume every paused Session. "Restart when idle" is removed. Stop all pauses after the turn, a new **Stop now** interrupts at once, and Widget updates pause and resume only that Widget's Sessions. A crash or reboot resumes running Sessions once on the next boot.

## User Stories

### Restarting

1. As the owner, I press Restart in the Shell (or run `kiln restart`) and Kiln restarts as soon as every running Session has finished its turn. Nothing new starts meanwhile, and the work carries on afterwards.
2. As the owner, while Kiln waits, a Shell-wide banner says "Restarting: waiting for 3 of 5 Sessions to finish their turn (9:12 left)", with **Restart now** and **Cancel**.
3. As the owner, **Restart now** (or `kiln restart --now`) interrupts the Sessions still running and restarts at once. They resume with "carry on where you left off", losing only the partial turn.
4. As the owner, **Cancel** works until the core actually goes down. Sessions already paused for the restart resume in place, and the scheduler starts new Sessions again.
5. As the owner, when the limit runs out, Kiln interrupts the Sessions still running and restarts, as if I had pressed Restart now.
6. As the owner, while the core is down the Shell shows "Kiln is restarting…" and reconnects by itself, never a broken board.
7. As the owner, afterwards the Shell says "5 Sessions resumed", or "4 resumed, 1 failed" with links to the failed Threads.
8. As the owner, each affected Thread shows "Paused for a Kiln restart after this turn" and then "Resumed after the restart".
9. As the owner, Up next keeps its order through a restart, and resumed Sessions keep their pool slots, so nothing else jumps in while Kiln is down.

### Asks across a restart

10. As the owner, a Session waiting on a blocking Ask stays `waiting` across the restart with its Ask open. When I answer, Kiln resumes its conversation with my answer.
11. As the owner, a Session waiting on a Permission Ask also stays `waiting`. When I answer, the resumed Session is told "your <action> was allowed" (or denied). On allow, that exact action is pre-allowed once, so the retried tool call doesn't ask me again.

### Every kind of Session

12. As the owner, local-model Sessions (llama-swap) resume on the same Variant and model, never re-routed. If the Variant is gone, the resume fails (story 14).
13. As the owner, Project Thread Sessions (and Scratch chats) resume the same way, in their own data-folder cwd.

### When a resume fails

14. As the owner, a resume that fails is retried once. If it fails again, the Session ends with a Thread note saying why, its commits and worktree are kept, and its Item goes to the **front** of Up next. The next Session starts fresh from Digests.

### Stop all, Stop now, Widget updates

15. As the owner, Stop all now lets running Sessions finish their turn, then pauses them. A new **Stop now** interrupts them at once. Both leave Sessions paused and resumable, and resume works whether or not the Agent's cache is still warm.
16. As the owner, updating a Widget that runs Sessions (for example Claude Code) uses the same pause after the turn, banner, limit, Restart now and Cancel, scoped to that Widget's Sessions. The scheduler holds new Sessions only for that Widget. The new Widget version takes back the stored resume tokens.

### Crashes and reboots

17. As the owner, after Kiln stops unexpectedly (a crash, a reboot, a killed process), Sessions that were running resume on the next boot with "carry on where you left off" and the note "Resumed after Kiln stopped unexpectedly".
18. As the owner, a Session gets at most one crash-resume. A second unplanned stop sends it down the failed-resume path (story 14), so a Session that crashes the core can't loop.

## Implementation Decisions

### Resume, not reattach

- Agent processes never outlive the core. There is no detaching and no reattach on boot. Every survival goes through the saved conversation.
- llama-swap is external and survives the restart on its own. Nothing here manages it.

### Widget SDK (`packages/widget-sdk/src/agent.ts`)

- A new Agent event `{ kind: 'resume_token'; token: string }`. The Agent sends it as soon as it knows the token (Claude Code: from the SDK's init message) and again whenever it changes. The core treats the token as opaque.
- `SessionStart` gains optional `resume?: { token: string; message: string; permission?: { action: string; allowed: boolean } }`. With it, the Agent continues the saved conversation in `worktree` (or the Session's cwd) instead of starting from `prompt`, and sends `message` as the first user turn. When `permission.allowed` is true, the Agent pre-allows that exact `action` once in the Session.
- A new command `{ type: 'agent.pause_after_turn'; sessionId: string }` and an Agent method `pauseAfterTurn(sessionId)`. The Agent lets the current turn end, sends nothing more, and reports `finished` with reason `'paused'`. `FinishReason` gains `'paused'`. An Agent that doesn't implement it gets `interrupt` instead (the core falls back), so older Widgets still work.
- A resume that can't continue (unknown token, model or Variant missing) reports `finished` with reason `'error'` and a message. The core counts it as a failed resume attempt.
- The Claude Code Widget (`widgets/claude-code/src/agent.ts`) implements all three, starting the SDK `query` with `resume: <token>` in the same cwd.
- The fake Agent (`packages/testing/src/fake-agent`) reports a token, accepts `resume` on start, logs it, and supports `pauseAfterTurn` and scripted resume failures.

### Persisted Session state

- The `sessions` table gains columns for what lives only in `live` today: resume token, pool slot, local attempt (Variant and model), `interrupted`, the pending Permission decision, the pause reason (`stop_all`, `restart`, `widget_update`), the crash-resume count and the failed-resume attempt count. A migration adds them, and existing rows get nulls and zeros.
- The token is written as soon as the `resume_token` event arrives, so a crash right after start can still resume.
- The boot cleanup that marks every live Session `stopped` is replaced:
  - `paused` with a restart reason: resume (planned restart).
  - `paused` by Stop all: stay `paused`, to resume when the person resumes.
  - `waiting`: stay `waiting` with its Ask open. The Ask's answer resumes it.
  - `running` (an unplanned stop): resume once if the crash-resume count is 0, then count it. Otherwise take the failed-resume path.
  - A live Session with no token: the failed-resume path.
- Resumed Sessions keep their Kiln Session id, Item, Stage, worktree, branch, base and pool slot. A Session is never re-routed to another Agent or Variant on resume.

### The pause coordinator (replaces `operations/restart.ts`)

- One coordinator runs a **drain**: a scope (all Sessions, or one Widget's), a reason, a deadline from the limit setting, and what happens when it ends (restart the core, update the Widget, or just stay paused for Stop all).
- On start it sends `pause_after_turn` to every running Session in scope and posts the "Paused … after this turn" note. A Session that is `waiting` already counts as paused.
- **Restart now** / the deadline: interrupt every Session in scope still running, mark it `interrupted`, then finish. Interrupted Sessions resume with "Kiln paused you; carry on where you left off."
- **Cancel**: allowed until the core or Widget actually goes down. Sessions paused for the drain resume in place (with their warm cache), and the hold lifts.
- While a drain runs, `blocksSessions()` holds new Sessions in its scope. The scheduler's `NOT_READY` match in `flow/scheduler.ts` moves from "waiting to restart" to a stable reason code from the coordinator, so Up next entries keep their place. A Widget update holds only Sessions that would use that Widget.
- Events: `core.restart_pending` (with counts and deadline), `core.restart_cancelled`, `core.restarting`, and after boot `core.restart_resumed { resumed, failed: [{ sessionId, itemId, reason }] }`. Widget updates publish the same shape with the Widget id.
- The limit is a core setting, 10 minutes by default. Its name and the exact banner and note wording are the implementer's call.

### Resume after boot

- Before the scheduler starts anything new, the core resumes every Session marked for it, in their pool slots, in the order they started. Up next is untouched.
- Each resume posts its Thread note ("Resumed after the restart" or "Resumed after Kiln stopped unexpectedly").
- A resume is cheap after a seconds-long restart, so the token is the basis whether or not `cacheWarm` says the cache is warm. A cold cache only costs more. The same holds for resuming after Stop all and Stop now.
- **Failed resume**: one retry. On the second failure the Session ends (`error`) with a Thread note saying why, keeps its commits and worktree, and its Item goes to the front of Up next. The next Session starts fresh from Digests.

### Asks

- An Ask answered while its Session is `waiting` resumes the Session. If the Agent process is gone (after a restart), that resume is a `SessionStart` with `resume` and the token. The answer goes in `message`, and a Permission answer goes in `permission`.
- The pending Permission decision is persisted until the resumed Session has started, so a crash in between doesn't lose it.

### Shell and CLI

- A Shell-wide banner driven by the restart events: progress, countdown, **Restart now**, **Cancel**. The same banner, naming the Widget, appears for a Widget update.
- "Kiln is restarting…" while the core is unreachable after `core.restarting`. The Shell keeps retrying and reloads its state on reconnect.
- After reconnect, the summary from `core.restart_resumed`, with links to failed Threads.
- `StopAll.tsx` gains Stop now beside Stop all. Settings drops "Restart when idle" for Restart.
- Routes: `POST /api/core/restart` (`{ now?: boolean }`), `POST /api/core/restart/now`, `DELETE /api/core/restart`, all Admin-only with no Widget grant. `POST /api/scheduler/stop-now` is Member, like stop-all. The `restart-when-idle` routes are removed, and `access.ts` follows.
- `kiln restart` is the safe Restart and `kiln restart --now` skips the wait. `kiln status` shows a pending restart's counts and time left. `doctor-cli.ts`'s fix text changes to "Restart".

### Order of the work

1. Persisted Session state and the new boot path (no behaviour change yet beyond not losing rows).
2. Widget SDK: resume token, `SessionStart.resume`, `pause_after_turn`. Then the fake Agent, then the Claude Code Widget.
3. The pause coordinator, with Stop all / Stop now on it.
4. Safe Restart (core, routes, CLI) replacing Restart when idle, and resume after boot with the failed-resume path.
5. Asks and Permission decisions across a restart.
6. Crash recovery.
7. Widget updates through the coordinator.
8. The Shell: banner, restarting screen, summary, Thread notes.

## Testing Decisions

- All tests drive Kiln from outside with `startTestKiln(t)` and `kiln.installFakeAgent({ script })`, and the Shell with `openShell`. None assert on tables or internal modules.
- Restart with Sessions mid-turn: they finish their turn, the core restarts, and each Session continues with the same Session id, worktree and slot. The fake Agent's log shows a start with the token it reported.
- Restart now and the deadline (set short in tests): running Sessions are interrupted and resume with "carry on where you left off".
- Cancel during a drain: Sessions resume in place and new Sessions start again. Cancel after `core.restarting` is refused.
- Up next keeps its order through a restart, and no new Session starts during the drain.
- Blocking Ask and Permission Ask across a restart: the Session stays `waiting`, and answering resumes it with the answer. An allowed action is not asked again on the retried call.
- A local-model Session resumes on the same Variant. With the Variant removed, its resume fails.
- A Project Thread Session resumes in its data-folder cwd.
- Failed resume: the fake Agent fails twice, so the Session ends with a note, its worktree is kept, and its Item is first in Up next. Failing once then succeeding resumes it.
- Crash recovery: kill the core process without a restart. The next boot resumes the running Session with the crash note. A second kill sends it down the failed path.
- Widget update: only that Widget's Sessions pause and resume, and other Widgets' Sessions keep running and starting.
- Stop all pauses after the turn and Stop now interrupts, and both resume with a cold cache.
- An Agent without `pauseAfterTurn` falls back to interrupt.
- Shell tests: the banner with counts and both buttons, the restarting screen, and the summary with links to failed Threads.
- The existing Restart when idle tests in `packages/core/test/operations.test.ts`, `cli-operations.test.ts` and `demo.test.ts` move to the new routes and behaviour.

## Out of Scope

- Detached Agent processes that outlive the core, or reattaching to them.
- Managing llama-swap across a restart.
- Restarting or upgrading the old Kiln board.
- Automatic restarts (for example on merge). Restart stays a person's action.
- Moving a Session to a different Agent, model or Variant on resume.

## Further Notes

- `GLOSSARY.md` should gain "Pause after this turn", "Stop now" and "resume token", and drop "Restart when idle".
- An ADR should record why Sessions survive by resuming the saved conversation rather than by keeping Agent processes alive, and that the resume token is opaque to the core.
- The new `'paused'` finish reason and `pause_after_turn` command extend the Agent interface of ADR 0004, so that ADR's interface list needs updating.
