# Review: 04 Story limits: table, API and access action

Commit reviewed: bef05b7. `npm ci` then `npm test`: 550 pass, 0 fail, 13 skipped.

## Verdict

Approve, with two small follow-ups. The diff does what the Ticket asks: the `story_limits` table, a default of 2 when there is no row, `Scheduler.setStoryLimit` (404 for an unknown Project, 400 unless a whole number from 0 to 10, then a dispatch), `PUT /api/scheduler/story-limits/:projectId {limit}`, the Admin-only `scheduler.story_limit` access action, and `limits {perProject, boxWide}` on `SchedulerState` (and so on `GET /api/scheduler` and `scheduler.updated`). Test 9 covers 403 for a Member, 400 for 11 and 1.5, 404, and the default of 2.

## Findings

1. **A stale limit survives unregistering a Project (should fix, small).** `work.unregister` deletes the Project's `maintenance_stories` row but nothing deletes its `story_limits` row. Project ids come from `slugify(name)`, so registering the same folder again, or another repo with the same name, gets the same id and silently inherits the old limit. Fix: delete the row on `project.removed` in the scheduler. The scheduler already handles that event for the queue (`scheduler.ts` ~line 251). The spec says the same for `story_order`.

2. **"Raising the limit dispatches at once" is not tested, and can't be yet (expected).** Dispatch does not read the limit yet (that is a later Ticket), so `setStoryLimit` only runs an ordinary dispatch. The part of test 9 that says raising the limit starts held Tickets has to be added with the dispatch Ticket. The implementer's Digest records this.

3. **How `boxWide` is computed (note for the dispatch Ticket).** `boxWide` is the largest Ticket first-Stage pool size across all Projects. With one pool (`agents`) this matches the spec. If Projects' Ticket kinds use different pools, a single cap of "the max" is looser than one cap per pool. Also, a Project with no `ticket` kind still appears in `perProject` with 2, even though the spec says it "is not limited". That is harmless for now, but the dispatch Ticket should treat such Projects as having no limit, and the Settings UI should not show a number for them. The test only checks that `boxWide` is a number, not its value or that it follows a pool resize.

4. **A new Project's limit is missing from the Shell until the next `scheduler.updated` (minor).** `project.registered` does not republish the scheduler state, so a client holding `limits.perProject` has no entry for the new Project until the next dispatch or change. The Settings UI Ticket should either default a missing entry to 2 or publish on `project.registered`.

5. **Nits in `scheduler-routes.ts`.** `const POOL =/^...` lost its space after `=`. In the header comment, the new longer route line pushed the `PUT /api/scheduler/queue` line out of column alignment with the others.

## Not in scope, confirmed absent

- Dispatch enforcement, held reasons "Waiting for a Story slot", and the Settings UI. These belong to later Tickets.
