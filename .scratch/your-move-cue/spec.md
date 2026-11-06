# Spec: A clear "Your move" cue when the person must start the next Stage

Status: ready-for-agent

Sources: `.scratch/your-move-cue/story.md`, the grill record `.scratch/your-move-cue/grill.md` (2026-11-06, every decision the person's), and the code on `kiln/story/your-move-cue` (2fad2d0). The choices the grill left open are settled here (see "Choices this spec made").

## Problem Statement

- Kiln already starts the next Stage by itself. When an Item enters a Stage that runs a Session (its Exit was met, a merge moved it, a Gate sent it back), the Scheduler's `admit` queues or starts it on `item.stage_changed` / `item.rework` (`packages/core/src/flow/scheduler.ts`). No Start press is needed.
- When that start fails for a reason other than "no Agent ready yet", the Scheduler publishes `scheduler.start_failed` and drops the Item from Up next. The same happens in `dispatchNow`, in `resume()` after Stop all, and in the Fable fallback re-queue (`packages/core/src/budgets/subscription-rules.ts`).
- Nothing in the Shell shows `scheduler.start_failed`. It is not in the Thread (`THREAD_TYPES` in `session-manager.ts` leaves it out), not on the card and not in Needs you. The Item sits in Backlog looking exactly like an Item a person parked on purpose.
- That is what happened in the first Live demo run. The Story sat at Spec / backlog after the grill, and the person could not tell whether to press Start or wait for the board.

## Solution

Auto-start stays as it is, everywhere. Kiln adds a **Stuck** mark: a stored record, per Item, that Kiln tried to start the Item's current Stage and could not. While an Item is Stuck, Kiln shows a **Your move** cue in three places: a card badge, a Needs you entry with a Start button, and a Thread message for each failed start. The mark clears by itself as soon as the Item is no longer stuck. It has no Dismiss.

## User Stories

### Seeing that it is my move

1. As the owner, when Kiln moves an Item into a Stage that runs a Session and the start fails, the Item's card shows a **Your move: Start** badge, wherever the card appears (Home board, Project board, the Item page header).
2. As the owner, hovering over or tapping the badge shows why the start failed, in plain words, for example "The Stage uses the pool "gpu", which does not exist".
3. As the owner, Needs you lists the Stuck Item with the reason and a **Start** button. The Needs you count in the header includes it.
4. As the owner, the Item's Thread shows a message for each failed start: "Kiln could not start Spec: <reason>". Two failures mean two messages.
5. As the owner, I get no browser or phone notification for this.

### Clearing the cue

6. As the owner, I press Start (on the badge, in Needs you or on the Item page). If the start works, the Session runs or the Item joins Up next, and the cue goes away everywhere at once.
7. As the owner, if my Start fails again, the cue stays and shows the new reason, and the Thread gets a new message.
8. As the owner, the cue also goes away when the Item changes Stage (I drag it, or the Tracker file changes), ships, is archived or deleted, or its Project is removed.
9. As the owner, to park a Stuck Item on purpose, I move it to a Stage that runs no Session or archive it. There is no Dismiss button.

### No false cues

10. As the owner, an Item I put in Backlog myself (a new Story I add by hand, an Item I drag back) never shows the cue unless Kiln then tries to start it and fails.
11. As the owner, while Stop all is on, queued Items are in Up next and show no cue.
12. As the owner, an Item waiting on an Ask or a Gate shows no cue. Its Ask is already in Needs you.
13. As the owner, an Item whose start is waiting for an Agent to be ready (the `NOT_READY` case) is in Up next, not Stuck.

### Across restarts and upgrades

14. As the owner, a Stuck Item is still Stuck after a core restart, with the same reason.
15. As the owner, an Item that got stuck before this shipped shows the cue after the upgrade, if its last start failed and nothing has happened to it since.

## Implementation Decisions

### What Stuck means

An Item is Stuck when **all** of these hold:

- it has a stored stuck mark, set by a failed start of its **current** Stage;
- its current Stage runs a Session (`stage.role` is set);
- it has no active Session (running, paused or waiting), is not in Up next, and has no open Ask or Gate wait.

The mark is what the grill calls "Kiln moved it there or tried to start it". The other conditions are checked again whenever the Item is shown, so a mark that is out of date never shows a cue. It is also cleared (below), so it never comes back later.

### The stuck mark (core)

- A new table `stuck_items (item_id TEXT PRIMARY KEY, project_id TEXT, stage TEXT, error TEXT, reason TEXT, at TEXT)`, added by a migration. One row per Item, holding the latest failure.
- A new module `packages/core/src/flow/stuck.ts` owns it. It subscribes to the bus:
  - `scheduler.start_failed` → upsert the row (stage = the Item's current Stage, `error` = the raw error, `reason` = the plain-words reason, `at` = now), then republish the Item.
  - `session.updated` into an active state for the Item, `item.stage_changed`, `item.rework`, the Item joining Up next (`work.setUpNext(id, true)`), Item archived or removed, `project.removed` → delete the row(s) and republish.
- Every place that starts an Item publishes `scheduler.start_failed` on a real failure. That covers the four existing places plus one new one: the **Start route** (`POST /api/items/:id/start`) and the Thread message start (`POST /api/items/:id/messages`) publish it when `enqueue` throws. They still return the error to the caller. The refusals that mean the Item is not stuck ("already in Up next", "already has a running Session", "Stage runs no Session", 404) do not publish.
- `start_failed` payload gains `stage` (the Item's Stage when it failed), so a mark for an old Stage is never written by a late event.

### Plain-words reasons

`stuck.ts` turns the raw error into a `reason` with a small table of known cases, matched on the `WorkError` messages the core already throws. Anything else is shown as the raw message, without a stack trace:

| Raw error contains | Reason shown |
| --- | --- |
| `uses the pool "<p>", which does not exist` | The Stage uses the pool "<p>", which does not exist. Add it in Settings or change the Stage. |
| An Agent or model that can't run the Stage (Agent Widget not installed or not approved, model missing) | No Agent can run this Stage: <detail>. |
| A git worktree or branch error (path already exists, branch already checked out, dirty worktree) | The worktree for this Item is in the way: <detail>. |

The table lives in one place, is tested through the API (below), and new cases are added as they turn up.

### API and SDK (`packages/widget-sdk`)

- `Item` gains `stuck?: { stage: string; reason: string; error: string; at: string }`. It is set only when every Stuck condition holds. `runState` is unchanged (a Stuck Item is still `backlog`), so the board columns don't move.
- `GET /api/stuck` returns the Stuck Items as `StuckItem[]` (`{ itemId, projectId, stage, reason, at }`), newest first. The Shell also gets them through the existing Item updates.
- No new start route: Start is the existing `POST /api/items/:id/start`.

### Thread message

- `scheduler.start_failed` joins `THREAD_TYPES`, so each failure shows in the **Item's** Thread, in order with its other events. It does not go to the Project Thread.
- The Shell's Thread view renders it as a Kiln note: "Kiln could not start <Stage name>: <reason>".
- The payload stores `reason` beside `error`, so old Thread entries keep the words they were shown with.

### Shell

- **Card badge**: a `Your move: Start` badge on every card of an Item with `stuck`. Its `title` and an accessible description hold the reason. Tapping it opens a small popover with the reason and a **Start** button (on touch, the tap opens the popover; it does not start at once).
- **Needs you**: a new "Your move" section above the Asks, one entry per Stuck Item: its title (a link to the Item), Project, Stage, the reason, when it failed, and a **Start** button. While the start is in flight the button is disabled. If it fails, the entry stays with the new reason (from the next update) and the error is shown under the button.
- The Needs you count is open Asks plus Stuck Items. "Nothing needs you" shows only when both are empty.
- The Item page header shows the same badge and Start button.
- Styling follows the existing dark default theme and the badge styles in `styles.css`.

### Items stuck before this ships

The migration that adds `stuck_items` seeds it once from the events log. For each Item whose latest `scheduler.start_failed` event comes after its latest `item.stage_changed`, `item.rework`, `session.*` start and Up next entry, it writes a row using that event's error. The normal Stuck conditions then decide whether a cue shows. There is no recurring startup sweep.

### Glossary

The first Ticket adds to `GLOSSARY.md`:

- **Stuck**: an Item in a Stage that runs a Session, whose start by Kiln failed, and that has no Session, no Up next entry and no open Ask.
- **Your move**: the cue the Shell shows for a Stuck Item (card badge, Needs you entry, Thread note).

### Choices this spec made (the grill left them open)

- **Stored mark, not worked out on the fly.** It survives a core restart, and checking it is cheap on every Item update.
- **A new Needs you entry kind, not a system Ask.** An Ask has an answer, a raiser and a `blocks` count, and is closed by answering. A Stuck entry is closed only by the Item's state (grill decision 4), so an Ask would need a special auto-resolve path through the Ask service and the Kiln MCP tools.
- **Item Thread only.** The failure is about one Item, and its events already carry `itemId`. Copying it to the Project Thread would add noise there.
- **One-off seed from the events log** for Items stuck before this ships, rather than a check at every startup.

### Order of the work

1. Core: `stuck_items` table and migration with the seed, `stuck.ts`, `stage` and `reason` on `start_failed`, the Start and message routes publish failures, `Item.stuck`, `GET /api/stuck`, `start_failed` in the Thread. Glossary entries.
2. Shell: card and Item page badge with popover, the Needs you "Your move" section and count, the Thread note.

## Testing Decisions

Tests drive Kiln from outside with `startTestKiln(t)` and `openShell(t, kiln)`, and never look at `stuck_items` directly.

- **Core** (`packages/core/test/stuck.test.ts`):
  - An Item moved by its Exit into a Stage whose pool does not exist gets `stuck` with the pool reason. `GET /api/stuck` lists it. Its Thread has one `scheduler.start_failed` entry.
  - Fix the pool and press Start: the Session starts, `stuck` is gone, `/api/stuck` is empty.
  - A failed Start press keeps `stuck`, updates `reason` and `at`, and adds a second Thread entry.
  - Moving a Stuck Item to another Stage, or to a Stage with no Session, clears it.
  - A new Item added by hand in a Session Stage's Backlog has no `stuck`.
  - Stop all on: an Item moved into a Session Stage goes to Up next, not Stuck.
  - The `NOT_READY` case (no Agent ready yet) queues the Item, not Stuck.
  - Restart the test core: a Stuck Item is still Stuck with the same reason.
  - The seed: a data folder with a `start_failed` event and no later activity (made by an older build's flow, then reopened) shows the Item Stuck after the migration.
  - Fake Agent: a scripted start failure (worktree in the way) gives the worktree reason.
- **Shell** (`packages/shell/test/your-move.test.ts`):
  - The card shows "Your move: Start" with the reason in its accessible description. Start from the popover starts the Session and the badge goes away.
  - Needs you lists the Stuck Item above Asks, counts it in the header and clears it when the Item starts. A failing Start shows the error and keeps the entry.
  - The Thread shows "Kiln could not start <Stage>: <reason>".

## Out of Scope

- A per-Stage "start by hand" setting, or any deliberate "waiting for Start" state (grill decision 1).
- A Dismiss or snooze for the cue (grill decision 4).
- Browser, phone or Shell-wide notifications (grill decision 3).
- Retrying failed starts automatically.
- Sessions that start and then end in `error` without meeting their Exit. They already show in the Thread as an ended Session. This Story covers starts that never happen.
- Project Thread Sessions and Scratch chats. They have no Stages to start.

## Further Notes

- The demo stall came after a hand fix of a stuck worktree. The worktree reason in the table above is the case to check first when trying this on a dev instance (`node packages/core/src/cli.ts dev`).
- If the reason table grows, keep it next to the `WorkError` messages it matches, so a changed message breaks a test, not the cue.
