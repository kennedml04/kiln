# Review: 01 Persist Session state and rework the boot path

Branch `kiln/ticket/safe-restart/01`, commit 79de8a8 (`packages/core/src/db.ts`, `packages/core/src/flow/session-manager.ts`).

Verdict: **changes requested**. The migration is right, and the boot classification follows the spec's rules. But the ticket asks for a test through `startTestKiln` and none was added. One persisted flag is also written stale, and the classification leaves rows in states the rest of the core can't act on.

## What matches the Ticket

- The migration adds all eight columns: `resume_token`, `pool_slot`, `local_attempt`, `interrupted`, `pending_permission`, `pause_reason`, `crash_resume_count` and `failed_resume_count`. Existing rows get null or 0 through the column defaults. It runs as one migration inside the runner's transaction, so a failure rolls back cleanly.
- The old `UPDATE … SET state = 'stopped'` boot cleanup is gone. The new loop follows the spec's five cases: paused for a restart resumes, paused by Stop all stays paused, waiting stays waiting, running gets one crash-resume, and no token takes the failed path.
- `pause()` records `stop_all`, `resume()` clears it, and `save()` now persists `interrupted`, the local attempt and the pause reason.

## Findings

### 1. No test (required by the Ticket) — must fix

The Ticket says "Test through startTestKiln, no table assertions". The Digest says a test can't be written until resume tokens exist. That is only half true: the no-token path is the only path reachable today, and it can be tested from outside now.

- `cli-operations.test.ts` already restarts a core on the same data folder (`restartedCore`). Killing the core's `pid` from `GET /api/core/status` and starting it again on the same `dataDir` would also work.
- Test: start a Session with `kiln.installFakeAgent` (a script that stays mid-turn), kill or restart the core, then check through the API that the Session has ended (`error`, not `running`), its Item is no longer `running`, and its worktree and branch still exist.
- This pins down the behaviour change below and gives tickets 04 and 06 a test to extend.

### 2. `interrupted` is persisted stale after an Ask resumes the Session — must fix

In the Ask-answered handler (`session-manager.ts`, around line 901), `save(info)` runs before `session.interrupted = false`:

```ts
info.state = 'running';
save(info);                       // writes interrupted = 1
if (session.interrupted) widgets.sendCommand(...agent.resume...);
session.interrupted = false;      // not saved
```

So a running Session keeps `interrupted = 1` in the row until something else saves it. Ticket 06 will read that row after a crash, and the stale flag will tell it the Session was interrupted when it wasn't. Clear the flag before `save`, or save again after clearing it. The same ordering exists in `raiseAsk` and `pause()`, but there the flag is set before `save`, so those two are fine.

### 3. The boot classification leaves rows that nothing in the core owns — should fix, or note it explicitly for 03/04/05

With a token, rows end up `paused` (reason `restart`, `crash` or `stop_all`) or `waiting`, but they are never put back into `live`, and the scheduler's `slots` don't count them. In that state:

- `work.ts` `runStateOf` shows the Item as **running** (for `paused`) or **waiting**, indefinitely.
- Stop, Resume, Stop all and Ask answers all look the Session up in `live`, so the person can't stop or resume it. An answer to its Ask finds no Session.
- Its pool slot is free in the scheduler, so another Session can take it, even though the spec says resumed Sessions keep their slot.

No token is written yet, so none of this can happen today. But the first ticket that writes a token (02) turns every planned restart into stuck Items unless 04 lands with it. Either rebuild a minimal `live` entry (or an "awaiting resume" set the API and scheduler respect) at boot, or record clearly in the tickets that 02 must not ship without 04 and 05.

### 4. Behaviour change: live Sessions now end `error` instead of `stopped`

The spec's order of work says step 1 is "no behaviour change yet beyond not losing rows". Because no token exists yet, every Session alive at boot now ends `error` (and `failed_resume_count` goes to 1) where it used to end `stopped`. The Shell shows "error in <Stage>" after every ordinary restart, with no `exit` message saying why. Nothing else keys off it at boot (the local-attempt record in `end()` isn't called from the boot path), so the impact is cosmetic and misleading rather than broken. Options:

- Give the failed path an `exit` message ("Kiln restarted and this Session could not be resumed"), which the spec wants anyway (story 14: "a Thread note saying why").
- Or keep `stopped` for the no-token case until ticket 02 writes tokens.

### 5. Smaller points

- **A `crash` reason is relabelled `restart` on a second boot.** A row already `paused` with reason `crash` (marked on boot N, core stops again before it resumes) gets `markResume('restart', 0)` on boot N+1, so it loses the "Resumed after Kiln stopped unexpectedly" note. Keep an existing `restart`/`crash` reason rather than overwriting it.
- **`pause_reason` stays set on ended rows.** A Session paused by Stop all and then stopped keeps `pause_reason = 'stop_all'`. The value is harmless (only active rows are read), but clearing it in `end()` would keep the column meaningful.
- **`failed_resume_count` jumps straight to the end.** The failed path increments the count and ends the Session in the same step, so the spec's "one retry" isn't modelled. That's fine for the no-token case (a retry can't help), but the column's later meaning ("attempts so far") should be settled when 04 adds the retry.
- **Stale comments.** The `pauseReason` type is only `'stop_all'`, while the boot code writes `restart` and `crash` straight to SQL, and `crash` isn't one of the spec's reasons (`stop_all`, `restart`, `widget_update`). Widen the type to the full set, including `crash` and `widget_update`, so the in-memory and persisted values agree. The `ACTIVE` doc comment ("paused by Stop all") is also out of date.
- `pool_slot` and `pending_permission` are columns only. That's acceptable for this ticket, but the Ticket's "Resumed Sessions keep … slot" can't hold until something writes `pool_slot`.

## Tests

I started `npm ci` and the full `npm test` on this branch, but the run hadn't finished when this review was committed, so I haven't confirmed the implementer's "506 tests, 0 failures" myself. These findings come from reading the code, not from test results.
