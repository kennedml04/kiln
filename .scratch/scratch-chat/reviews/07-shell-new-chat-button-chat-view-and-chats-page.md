# Review: 07 Shell: New chat button, chat view and Chats page

Reviewed: commit 76cf249 (on top of the merge of scratch-chat/06, 12bac1b), against the ticket and `spec.md` (Shell, decision 10; Core API).

**Verdict:** accept, with follow-ups. Everything the ticket asks for is built and tested. Nothing blocks merging. The items below are small gaps, or work that tickets 06/08/09/10 have to pick up.

Checked: `node --test packages/shell/test/chats.test.ts` after a Shell build passes all 5 tests. I did not rerun the full `npm test`; the implementer's Digest reports 502 passing.

## What the ticket asks for, and where it is

| Ticket ask | Status |
| --- | --- |
| New chat button in the header, next to Stop all | Done. It is in `sidebar-footer` beside `<StopAll>` (`App.tsx`). At phone width the sidebar becomes the top bar. |
| Icon on phone | Done. Below 860px the label is visually hidden and the button is 2.4rem. The test checks it is ≤48px wide. |
| Hidden for Viewers | Done (`canAct`), and tested. The core already refuses `POST /api/chats` from Viewers (the default rule: a mutating request needs Member). |
| Chat created on first message | Done. `/chats/new` only POSTs on Send. The test checks that `GET /api/chats` is empty after opening the view. |
| Chat view: Thread, message box, rename, Pin, Archive | Done (`work/Chats.tsx`). Click the title to rename. Pin/Unpin and Archive/Unarchive go through the new `PATCH /api/chats/:id`. |
| Chats page: pinned first, Archived tab, Admin "Everyone's chats" | Done (`work/ChatsPage.tsx`). `all=1` returns 403 for anyone but an Admin. |
| Chat Asks in Needs you, labelled with the chat title | Done. Needs you shows "Chat: <title>" and links to the chat (`NeedsYou.tsx`). The Ask service now accepts `chat:` subjects. |
| Not on boards or Up next | Met by construction: chats never enter `items`, and Thread events only go into `threads`. No test asserts it (see 6). |
| Playwright at desktop and phone width | Done: 5 tests, one of them at 390px. |

## Findings

### 1. `PATCH /api/chats/:id` has no owner check (medium; ticket 06 must cover it)
`routes.ts` looks up the chat by id and patches it for any Member. A second Member who learns a chat id can rename, pin or archive someone else's chat. Reads have the same gap, and the Digest already flags it as ticket 06's job. This ticket adds a *write* route with the gap, though, so 06's route checks must include PATCH and return 404 for it. Ids are random, so the risk is low until then.

### 2. Manual Archive leaves a live Session running (low)
`Chats.update({ archived: true })` only sets `archived_at`. The spec says: "Archiving only sets `archivedAt`. A live Session for an archived chat is ended first." That rule sits under the sweep, but Archive from the toolbar is the same state change. As it stands, a chat can show "Archived" while its Session is still running and drawing on the Budget. Either end the Session in the PATCH path, or make sure ticket 10 puts the "end it first" step in `Chats.update`, not only in the sweep.

### 3. The chat view does not show the chat's Asks (low)
The spec's chat view Thread includes Asks, and an Admin is meant to see a chat's Ask "on the chat itself, not in their Needs you". `line()` in `Chats.tsx` renders only messages, progress, Session start/end and Digests, so the only way to answer a chat Ask is through Needs you. The Item view has the same limit today, so this is consistent with existing code. It does become necessary once ticket 06 sends chat Asks only to the owner's Needs you: an Admin will have no way to see them.

### 4. `loadChats` on `core.hello` replaces the whole chat map (low)
`store.ts` `loadChats` calls `update({ chats: byId(...) })`, which drops any chats the Admin loaded through "Everyone's chats". After a reconnect, with the toggle still on, the list shows only the Admin's own chats until the toggle is switched off and on again. Fix: merge, or have `ChatsPage` refetch when the connection comes back. Relatedly, until ticket 06 filters SSE, `chat.opened`/`chat.updated` events for every person's chats reach every Shell's store. `ChatsPage` filters by owner, so nothing shows, but the data is in the browser.

### 5. Owner column shows the raw owner id (low, already in the Digest)
"Everyone's chats" shows `ownerId` (`mia`, or `local`). The spec asks for chats "labelled with who opened them". An id is enough for Tailscale logins, but it is not a display name.

### 6. Test gaps (low)
- Nothing asserts that a chat stays off the boards and Up next (for example, the Home board and Up next unchanged after a chat is opened and running).
- The phone-width test checks for sideways scroll only on `/chats`, not on the chat view, where the toolbar (title, Pin, Archive, and later Make it a Story) is the layout most likely to overflow.
- No API-level test for `PATCH` validation (`title: ""`, `pinned: "yes"` → 400) or for `all=1` returning 403 to a Member.

### 7. Small code notes (nit)
- `ask-service.ts`: a `chat:<id>` Ask is accepted without checking that the chat exists. Only Sessions raise these, so it is harmless, but the 404 the other subjects get would be more consistent.
- `session-manager.ts`: skipping `planLocal` for chats (`project ? planLocal(...) : { stage }`) is a reasonable stop-gap, and it matches the spec's Further Notes on local-first.
- The merge's `CHAT_POLICY` spells out `worktree_read: 'allow'`, where the spec says "PROJECT_THREAD_POLICY with network allowed". The effect is the same, since read is allowed by default, but it is now a separate literal that can drift from the Project Thread policy.

## Scope notes
- This branch merges scratch-chat/06 (with 01) so it has a backend. The merge order into the Story branch has to keep that in mind.
- Make it a Story, Save as a note and the Story-link Thread entries are left to tickets 08/09, as the Digest says. That fits this ticket's wording.
