# Review: 10 Archiving and deletion sweep

## Round 2 (2026-11-05, at bf2cac0)

**Verdict: still changes requested.** Findings 1 and 2 from round 1 (below) are not fixed. The only code change since round 1 is bf2cac0.

Checks run: `node --test packages/core/test/scratch-chat.test.ts` (6/6 pass) and `npm run typecheck` (clean).

### bf2cac0: no local routing for chats

`session-manager.ts:927` now skips `planLocal` when there is no Project and uses `{ stage }` as is. That's correct. A chat has no Project Workflow, and the spec keeps local-first routing for the `chat` role out of scope. Only a chat subject has no Project at this point (Project Threads and Items always have one), so nothing else changes. No test covers it directly, but every chat test starts a Session through this path, so a regression would show up there.

### Round 1 findings, checked again

- **F1 still open.** `chats/routes.ts:105` still ends the Session before `chats.update` quietly refuses to archive a pinned chat (`chats.ts:133`). Still a blocker.
- **F2 still open.** `chats.ts:138-153` still loops over a snapshot, awaits `endSessions`, then calls `setArchived` or `remove` without reading the row again. `server.ts:169` still starts sweeps with no serialisation, from start, the interval and `clock.onChange`. Still a blocker.
- **F3, F4 and F5 still open.** `server.ts:169` still does `.catch(() => undefined)`. These stay minor, as before.

The implementing Session after round 1 wrote an empty Digest, so nothing says these were declined on purpose. The next implementing Session should fix F1 and F2 (and F4, which is one line) and add tests for F1 and the folder deletion in F5.

---

## Round 1
Branch: `kiln/ticket/scratch-chat/10` at 22d3c11 (it also merges `kiln/ticket/scratch-chat/01`).
Reviewed against the ticket and spec § "Archiving and deletion" (decision 4).

**Verdict: approve once findings 1 and 2 are fixed.** The rest can go to follow-ups.

Checks run: `node --test packages/core/test/scratch-chat.test.ts` (6/6 pass) and `npm run typecheck` (clean).

## What matches the ticket

- The sweep runs at core start, hourly (`setInterval`, unref'd, cleared on stop) and whenever the test clock moves, all on the injectable clock.
- Unpinned, unarchived chats idle more than 7 days are archived, and their live Sessions end first. Pinned chats are skipped.
- Chats archived more than 30 days are deleted. That removes the row, Thread events (payload `itemId: chat:<id>` or `chatId`), Asks, Session rows and `<dataDir>/chats/<id>/` (Digests included). `usage_records` and `audit_log` are untouched (the audit log can't be deleted from anyway).
- A message un-archives a chat (`touch` clears `archived_at`). So do pinning and `PATCH archived:false`.
- `PATCH /api/chats/:id { title?, pinned?, archived? }` validates its types, notes the audit target and has a Member access rule.
- The seeding fix in `session-manager.ts` (render Digests with the chat's own store) is correct and needed.

## Findings

### 1. Should fix: `PATCH archived:true` on a pinned chat ends its Session but doesn't archive it

`packages/core/src/chats/routes.ts:105` calls `sessions.endItem(...)` whenever `archived === true` and the chat isn't archived yet. Then `chats.update` quietly refuses to archive because the chat is pinned, and the route returns 200. The person loses the live Session (and its warm cache), the chat stays unarchived, and nothing says why.

The spec gives the Archive button as the way to get a chat deleted sooner. It never says a pinned chat can't be archived by hand. Pick one:
- **(a)** archiving by hand also unpins (most in keeping with "archive it and it's deleted 30 days later"); or
- **(b)** refuse with 409 "Unpin the chat first".

Either way, decide whether to archive *before* ending Sessions, and add a test.

### 2. Should fix: the sweep can archive or delete a chat that was just messaged, and sweeps can overlap

`chats.ts:138` reads every row up front and then `await endSessions(...)` for each chat. It then calls `setArchived`/`remove` without reading the row again. If a message comes in during that await (`touch` clears `archived_at` and starts a fresh Session), the sweep then archives a chat that was just used, or deletes one that was just un-archived. The new Session is left running against an archived or deleted chat.

The sweep can also start from three places (start, the interval, `clock.onChange`) and nothing serialises them, so two sweeps can interleave.

Fix: chain sweeps on one promise (or skip if one is already running). After the await, re-`get(id)` and re-check the condition before archiving or removing.

### 3. Minor: deletion bypasses the Ask service and sends no "gone" events

`remove()` deletes `asks` rows with raw SQL. No `ask.*` event goes out, so a Needs you already open over SSE keeps showing the deleted chat's Ask until reload. The Ask service's in-memory `waitingOn` entry for it is never cleared either. In the same way, deletion publishes nothing like `chat.deleted`, so an open Chats page keeps listing the chat.

Suggest an Ask-service method to drop an item's Asks (publishing `ask.removed` or similar) and a `chat.deleted` event. The Shell ticket (07) will need the event anyway.

### 4. Minor: sweep errors are silently swallowed

`server.ts:168` uses `.catch(() => undefined)`. If the sweep fails (a locked folder on Windows when `rmSync` runs while an Agent still holds a handle, say), nothing is logged and it just retries next hour. Log it through the core's logger.

### 5. Test gaps

The new test covers 7-day archiving, the pinned exemption, un-archiving by message, archiving by hand and 30-day deletion with usage kept. It does not check:
- that `<dataDir>/chats/<id>/` is gone after deletion (the spec's Testing Decisions list this);
- that the chat's Asks and Thread entries are gone, or that a Story or note made from it survives (that waits on tickets 08 and 09; leave a TODO);
- that pinning an archived chat un-archives it, or that `PATCH title` works;
- that a paused Session (a cap Ask pending) is ended on archive: `endItem` handles it through `ACTIVE`, but nothing tests it;
- finding 1's case.

## Gaps the Digest already names (follow-ups, not blockers)

- **Pending Make it a Story draft:** deletion doesn't drop it, because ticket 08 isn't on this branch. Whichever of 08 or 10 merges second must add it.
- **Privacy:** `PATCH /api/chats/:id` has no owner/Admin 404 check yet (ticket 06).
- **"Reopening from the Archived tab un-archives it":** the core has no implicit un-archive on `GET`. The Shell (ticket 07) must send `PATCH archived:false` when it reopens an archived chat. Note this in 07.
- **Merge shape:** this branch contains a merge of ticket 01. Whoever integrates should merge 01 first so 10's diff stays readable, and watch for conflicts in `chats.ts`, `routes.ts` and `server.ts`.
