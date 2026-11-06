# Review: 08 Make it a Story

Reviewed commit 5bbf0c5 (the merges of 10 and 03 that come before it are reviewed in their own files) against the ticket and the spec's "Make it a Story" section.

Checks: `npm run typecheck` is clean, and `node --test packages/core/test/chat-make-story.test.ts` passes (3 of 3). I did not run the full suite.

## What meets the ticket

- `POST`, `GET` and `DELETE /api/chats/:id/story-draft` and `POST /api/chats/:id/story` exist, with Member-role access rules and audit notes.
- Drafts live only in memory, at most one per chat. They expire after 30 minutes on the injectable clock: checked when read, and swept every minute.
- `draft_story` fills the pending draft and is refused when none is pending (`story-drafts.ts` `fill`).
- Accept goes through `work.createItem`, the path Shell-created Items use, so the markdown Tracker makes one commit on the default branch. The Story is kind `story` and starts in its first Stage, which is `grill` in the default Workflow. The chosen Epic is checked before the chat is asked to draft anything.
- `item.from_chat` and `chat.story_made` are runtime events added to `THREAD_TYPES`. `story.md` carries no chat id, and the test checks this. `chats.addStory` records the Story id on the chat.
- The Story's Thread route drops `chatId` for callers who are neither the chat's owner nor an Admin, and for everyone once the chat is deleted (`linkVisibleTo`).
- The test confirms that the first grill Session's seed contains nothing from the chat.

## Findings

### 1. Two Accepts at once create two Stories (medium)

`chats/routes.ts`, the `story` POST: `drafts.get` checks for a pending draft, then `await work.createItem(...)`, and only then `drafts.close(id, 'accepted')`. Two requests that overlap, such as a double submit, a retry after a slow commit, or two tabs, both pass the check and each creates a Story and a commit. The Shell's `busy` flag only guards one dialog. Fix: claim the draft before creating the Item, for example with a `take()` that removes it at once, and put it back if `createItem` throws.

### 2. `item.from_chat` leaks the chat id over SSE (medium, belongs with ticket 06)

`bus.publish(ITEM_FROM_CHAT, { itemId: <story>, chatId })` goes to every SSE connection, and its subject is the Story, not the chat. `linkVisibleTo` only filters `GET /api/items/:id/thread`. The Shell's store now accepts `item.from_chat` events live (`THREAD_EVENT`), so any Member watching that Story gets the chat id, and `ThreadLog` renders it as a link. This goes against spec decision 12: the link opens the chat only for its owner and Admins. Ticket 06's planned filter by chat subject will not catch this, because the subject is the Story. Either redact `chatId` per connection for this event type, or have the Shell refetch the Thread instead of trusting the event payload. Record this in ticket 06.

### 3. No chat-visibility check on the new routes (medium, depends on ticket 06)

Any Member can open, read, cancel or accept a draft on any chat, and so can make another person's chat draft and link a Story. This matches the other chat routes in this branch, none of which check the owner yet. Ticket 06 must cover `story-draft` and `story` as well.

### 4. The Shell waits by polling, not on the SSE event (low)

The spec says the Shell shows the draft when an SSE event on the chat fills it. The core publishes `chat.story_draft` (states pending, ready, cancelled, accepted, expired), but `MakeStoryDialog` ignores it and polls `GET story-draft` every second for as long as it is open, including while the person edits. It works, but it makes needless requests. When the 30 minutes run out mid-edit, the 404 sends the dialog back to the Project picker and the edits are lost, although an error message is shown.

### 5. Reopening a filled draft leaves Accept disabled for a moment (low)

The first `GET` in `MakeStoryDialog` sets `draft`, `projectId` and `parentId` but not `title` or `description`. The fields are empty, and Accept stays disabled, until the next poll fills them about a second later.

### 6. The dialog is not mounted, and no Playwright test covers it (open, depends on ticket 07)

Nothing renders `MakeStoryDialog`, and the Story Thread's link points at `/chats/:id`, a route the Shell does not have yet. The spec's Shell test ("Make it a Story through to the Story's Thread and back") is not written. The implementer's Digest records this. Ticket 07 must mount the dialog from the chat toolbar, render `chat.story_made` in the chat's Thread (the Shell's `THREAD_EVENT` does not include it), and add the Playwright test.

### 7. Smaller points (low)

- Accept takes its `projectId` and `parentId` from the request body and does not compare them with the pending draft's, so a draft opened for Project A can be accepted into Project B. The spec's request shape allows this, but it should either be deliberate or be rejected.
- "Stage Grill" depends on the Project's Workflow listing `grill` first for `story`. For any other Workflow the Story starts in that Workflow's first Stage. That is probably right, but it is unstated.
- The tests do not cover the redaction in `linkVisibleTo`: the link should be hidden from a second Member and visible to an Admin. That test can come with ticket 06.

## Verdict

The core flow matches the ticket and is tested end to end. Fix finding 1 before merging. Findings 2 and 3 should go into ticket 06's scope, and finding 6 into ticket 07's.
