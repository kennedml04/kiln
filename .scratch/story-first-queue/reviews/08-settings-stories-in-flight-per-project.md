# Review: 08 Settings: Stories in flight per Project

Commit reviewed: 2bed3ad (`packages/shell/src/work/SettingsPage.tsx`, `packages/shell/test/scheduler.test.ts`).

Verified in this worktree: Shell builds, `tsc --noEmit` is clean, `npm run check` passes, and `node --test packages/shell/test/scheduler.test.ts` passes 5/5, including the new Shell test 11. The full `npm test` was not run.

## Verdict

Request changes. The Admin path works and matches spec test 11. But the ticket's "read-only text for Members and Viewers" (spec user story 7) is not delivered: no one other than an Admin can reach that text.

## Findings

### 1. Members and Viewers can't see the limits (blocking)

`App.tsx:104` renders `SettingsPage` only when `isAdmin`, and the Settings nav link is Admin-only too. So the `!canEdit` branch of `StoryLimitRow` can never render. The ticket asks for "read-only text for Members and Viewers". Spec story 7 says "Members and Viewers see these numbers but can't change them". The Digest records keeping Settings Admin-only as a choice, but that drops part of the ticket.

Fix: show the "Stories in flight" block (read-only) where non-Admins can see it. One way: let non-Admins open Settings and see just this block and the pools, read-only. Another: show the block on the board or Home. If the person prefers to keep Settings Admin-only, it should be their decision (raise an Ask) and noted in the spec, not decided quietly.

### 2. The read-only branch has no test

Nothing covers what a Member or Viewer sees. Once finding 1 is fixed, add a Shell test: a Member sees "<Project>: 2" and no spinbutton or Save button.

### 3. Saving an empty field sets the limit to 0 (minor)

`Number(value)` with an empty input is `0`. So clearing the field and pressing Save quietly stops the Project from starting new Stories. The core accepts 0, since it's a valid pause. Fix: add `required` to the input, or refuse `''` before the PUT.

### 4. The test doesn't check the cap's number (minor)

The test waits for `/At most \d+ across all Projects/` but never checks that N equals `limits.boxWide` or the agents pool size. It would still pass if the line showed the wrong number. Fix: read `GET /api/scheduler` and assert on the exact text, or change the agents pool and check that the line follows.

### 5. Small points (optional)

- Projects show in store insertion order. Sorting by name would keep the list stable.
- A Project whose Workflow has no `ticket` kind is not limited (spec, Limits), yet it still gets an input. It could be hidden or marked "not limited".
- The cap line always says "the agents pool size". The core uses the pool of the Ticket kind's first Stage, which is `agents` by default. This matches the spec's wording, so it's fine for now.
- The Digest's open point about a capital "At most" is fine: it starts a sentence.

## What is good

- It follows the `PoolRow` pattern (form, `role="status"`, an alert on error), and the input is clamped 0–10 with step 1.
- It relies on `scheduler.updated` (setStoryLimit dispatches, which publishes) rather than applying the PUT response locally, so other open Shells update too.
- `useEffect` re-syncs the input when the stored limit changes from elsewhere.
- Unset limits show 2, the same default as the core.
