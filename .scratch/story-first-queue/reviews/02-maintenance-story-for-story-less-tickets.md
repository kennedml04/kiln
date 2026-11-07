# Review: 02 Maintenance Story for Story-less Tickets

Branch `kiln/ticket/story-first-queue/02`, commit 841fdf6, reviewed against the Ticket and the spec's "Items: Blocked by and Maintenance" section.

Verdict: **approve with follow-ups**. The Ticket's three required behaviours are built and tested through the API:

- A POST of a Ticket without a parent succeeds and gets the Maintenance Story.
- A `.scratch/items/ticket/` record without `parent` gets the same parent.
- The Maintenance Story never ships.

The findings below are edge cases and gaps. None of them blocks the Ticket's acceptance.

## Test run

I started `npm test` in this worktree and it had not finished when these findings were committed: it ran past 10 minutes with no output yet. If it finishes, its result goes in a follow-up commit below.

The implementing Session's own run: 548 pass and 1 fail before its `projects.test.ts` fix. After the fix it reran only `projects.test.ts` (9 pass).

## What matches the Ticket

- `.scratch/maintenance/story.md` is written with `title: Maintenance`, `stage: tickets` and `maintenance: true`, and is read back as `item.maintenance`. The test checks the file.
- Story-less Tickets get the Maintenance Story as `parentId` and are listed in its `childIds`. The Ticket's own record is not rewritten.
- `createItem`: a `parentRequired` kind whose parent kind is `story` now files under Maintenance. Other cases still get 400, and the updated `projects.test.ts` checks the Ticket-under-an-Epic case.
- Roll-up skips the Maintenance Story both when checking whether to ship it and in `startChildren`. The scheduler's `admit` skips it, and `enqueue` refuses it with 409.
- `moveTo` (which both `advance` and `sendBack` use) refuses with 409 "The Maintenance Story stays open". `moveItem` already refused every move.
- Widget Trackers: the Story is created through `tracker.create` and remembered in `maintenance_stories`. The row is deleted when the Project is unregistered.

## Findings

### 1. A hand-written `.scratch/items/ticket/*.md` with no `stage:` line can never change Stage (medium)

`readOtherKinds` reads these records' Stage only from frontmatter (`front.stage`). But `writeStage` treats every `kind === 'ticket'` record as a layout Ticket and calls `setField(lines, 'Stage', ...)`.

- When the frontmatter has a `stage:` line, it works only by accident: `fieldLine` is case-insensitive and matches `stage: x` as well as `**Stage:**`.
- When the frontmatter has no `stage:` line (allowed: `settle` gives it the first Stage), `setField` adds a `**Stage:** <next>` line to the body. The reader ignores that line, so the Ticket reads back at its first Stage after every move. The Ticket can never move forward, and each attempt makes another commit.

Fix: in `writeStage`, branch on the record's path (`.scratch/items/`) rather than its kind, and use `setFrontmatter` for these records, as other `items/<kind>` records do. Add a test that moves such a Ticket one Stage.

### 2. Two Maintenance Stories can be made (low)

`makeMaintenance` is called from two places:

- `refresh`, which runs inside the `entry.refreshing` chain;
- `createItem`, which runs outside it and only checks `target.items`.

If a refresh that has seen a parentless record is creating the Story while a POST arrives, both write one. The second becomes `.scratch/maintenance-2/story.md` because of `takenKeys`. `maintenanceKeyOf` then picks whichever comes first, and the other Story is a second, permanent, never-shipping Story.

There is a second path for Widget Trackers. If the Tracker does not list the remembered key (it was deleted, or the list is temporarily incomplete), every refresh that sees a parentless Ticket makes a new Story and overwrites the row.

Fix: run creation inside the refresh chain, or through one shared promise per Project.

### 3. A Widget Tracker that does store the flag is only half honoured (low)

`toItems` marks a Story as `maintenance` when `record.maintenance` is set. But for non-markdown Trackers, `maintenanceKeyOf` looks only at the table.

So a Widget Tracker that returns `maintenance: true` but has no table row (for example, after the Project was registered again) gets:

- a Story flagged as Maintenance with no Tickets hung on it;
- plus a newly created second Maintenance Story.

Fix: fall back to `recs.find(r => r.kind === 'story' && r.maintenance)` for every Tracker. Use the table only when that finds nothing.

### 4. A `ticket/<slug>` key can clash with a layout Ticket's branch (low)

A `.scratch/items/ticket/<slug>.md` record has the key `ticket/<slug>`, so its branch is `kiln/ticket/<slug>`. If a Story has the same slug, its Tickets' branches are `kiln/ticket/<slug>/NN`. Git cannot hold both refs, so whichever Session starts second fails to create its branch.

This is rare, since it needs a hand-written record named like a Story. Either refuse such a slug, or give these Tickets a different key prefix (for example `ticket/items/<slug>`).

### 5. Spec deviations to record (info)

- The table is `maintenance_stories (project_id, story_key)`, not `story_id` as the spec says. A key is the better choice (Item ids are derived from keys), but the spec should say so.
- "No parent" means the Tracker gave no `parentKey`. A Ticket whose `parentKey` names a Story that is missing stays parentless and is not moved to Maintenance. That is defensible, but spec story 24 reads as "any Ticket with no Story". Decide which is meant.
- If the main checkout is off the default branch, the create in `refresh` fails silently, and the Tickets stay parentless until a later refresh succeeds. `createItem` answers 409 in that case, which is consistent with today's refusal.

### 6. Test gaps (info)

- No test reaches the 409 from `moveTo`. A send-back or advance through Gates cannot normally reach a Maintenance Story, so a unit-level check is acceptable, but nothing guards against a regression. One way to cover it is a Gate Ask raised on the Maintenance Story.
- The "never ships" test uses a Ticket that is already shipped when the Project is registered. Roll-up runs on `item.stage_changed`, so the case that matters is a Maintenance Ticket moving to Shipped while Kiln runs. That case is not tested, though the `item.maintenance` guard in `check` covers it by reading.
- No test covers the Widget Tracker path (`maintenance_stories`).

### 7. The Shell still offers "Start Session" on the Maintenance Story (info, for a later Ticket)

`ItemView` shows the button for every Item. On the Maintenance Story, clicking it shows the 409 message. Hide it when `item.maintenance` is set. The Story-card Shell Tickets may already cover this.

## Not in scope here (later Tickets)

`blockedBy`, Story order, putting Maintenance at the bottom of the order, the in-flight limit, and the "N shipped, K open" card. The Digest correctly lists these as open.
