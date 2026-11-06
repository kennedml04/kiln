# Review: 07 Shell: New chat button, chat view and Chats page

## Round 2 (2026-11-06, at 94dd632)

Reviewed: the branch at 94dd632, against the ticket, `spec.md` (Shell, decision 10) and what the 08 review handed to this ticket. Since round 1 (e016968), every change on the branch came in through merges of master: tickets 06 (route 404s), 08 (Make it a Story), 10 (sweep) and unrelated Stories. The last implementing Session changed nothing.

**Verdict:** changes requested. The ticket's own asks are still met and tested. But now that ticket 08 is on this branch, the 08 review's hand-off to this ticket ("Ticket 07 must mount the dialog from the chat toolbar, render `chat.story_made` in the chat's Thread … and add the Playwright test") is not done. As things stand, the Shell has no way to reach Make it a Story.

Checked: Shell build, then `node --test packages/shell/test/chats.test.ts packages/core/test/scratch-chat.test.ts packages/core/test/chat-make-story.test.ts`: 17/17 pass. I did not rerun the full `npm test`.

### R2-1. Make it a Story can't be reached from the chat view (high: blocks the Story's Shell flow)
`packages/shell/src/work/MakeStoryDialog.tsx` is defined, but nothing imports or renders it (`git grep MakeStoryDialog` finds only its own definition). The chat toolbar in `work/Chats.tsx` still has only the title, Pin and Archive. The spec's chat view toolbar has "the title (click to rename), Pin, Make it a Story and Archive". To fix:
- add a **Make it a Story** button to the chat toolbar (hidden for Viewers, as New chat is) that opens `MakeStoryDialog` with the chat, and on `onMade` shows the new Story's link or goes to it;
- check the toolbar still fits at 390px without sideways scroll once the button is there (see round 1, finding 6).

### R2-2. `chat.story_made` is neither delivered live nor rendered in the chat's Thread (medium)
- `store.ts` `THREAD_EVENT` now includes `item.from_chat` but not `chat.story_made`, so a Story made from the chat doesn't appear in the open chat view until it reloads.
- `line()` in `Chats.tsx` has no case for `chat.story_made`, so even after a reload the entry isn't shown. The spec: "the chat shows a link to the Story", and the chat view's Thread includes "Story links". Render it as a line that links to `itemPath(storyId)`. `chat.stories` is also on the record and could be listed in the toolbar.
- Check that the core's `GET /api/chats/:id/thread` returns `chat.story_made` entries (they are published with `itemId: chat:<id>`, so they should be).

### R2-3. No Shell test for Make it a Story through to the Story's Thread and back (medium)
The spec's Shell test list includes "Make it a Story through to the Story's Thread and back". Neither 08 nor this branch has it. With the fake Agent calling `draft_story`, it should cover: open the dialog from the chat toolbar, pick a Project (and an Epic), edit the title, Accept, see the Story's Thread with "Made from a Scratch chat" linking to `/chats/:id`, follow that link back, and see the Story link in the chat.

### Round 1 findings, status now
| # | Finding | Now |
| --- | --- | --- |
| 1 | PATCH has no owner check | **Fixed** (via ticket 06, c4c0096): every `/api/chats/:id` route returns 404 to anyone but the owner or an Admin, PATCH included, and it is tested. |
| 2 | Manual Archive leaves the Session running | **Fixed** (via ticket 10): PATCH `archived: true` calls `sessions.endItem` first, and archiving by hand also unpins. |
| 3 | Chat view doesn't show the chat's Asks | Open. Still matters for Admins once Needs you routes chat Asks only to the owner. |
| 4 | `loadChats` on `core.hello` replaces the chat map | Open (`store.ts:115`). It drops chats an Admin loaded through Everyone's chats after a reconnect. |
| 5 | Owner column shows the raw owner id | Open. Low. |
| 6 | Test gaps (off boards and Up next; phone overflow on the chat view; PATCH validation and `all=1` 403 API tests) | Open. Also, after the merge, `PATCH { title: "" }` is now ignored and returns 200 where it used to return 400. Either is defensible, but a test should pin down which one. |
| 7 | Nits | Unchanged. |

### Not this ticket's to fix
- The 08 review's notes on `MakeStoryDialog` itself (it polls instead of using the `chat.story_draft` SSE event, it loses edits on expiry, and the title and description are empty for the first second) are ticket 08's. Whoever does R2-1 may want to fix them while in the file.
- Save as a note is still ticket 09's.

---

## Round 1 (at 76cf249)

Reviewed: commit 76cf249 (on top of the merge of scratch-chat/06, 12bac1b), against the ticket and `spec.md` (Shell, decision 10; Core API).

**Verdict:** accept, with follow-ups. Everything the ticket asks for is built and tested. Nothing blocks merging. The items below are small gaps, or work that tickets 06/08/09/10 have to pick up.

Checked: `node --test packages/shell/test/chats.test.ts` after a Shell build passes all 5 tests. I did not rerun the full `npm test`; the implementer's Digest reports 502 passing.

### What the ticket asks for, and where it is

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

### Findings

#### 1. `PATCH /api/chats/:id` has no owner check (medium; ticket 06 must cover it)
`routes.ts` looks up the chat by id and patches it for any Member. A second Member who learns a chat id can rename, pin or archive someone else's chat. Reads have the same gap, and the Digest already flags it as ticket 06's job. This ticket adds a *write* route with the gap, though, so 06's route checks must include PATCH and return 404 for it. Ids are random, so the risk is low until then.

#### 2. Manual Archive leaves a live Session running (low)
`Chats.update({ archived: true })` only sets `archived_at`. The spec says: "Archiving only sets `archivedAt`. A live Session for an archived chat is ended first." That rule sits under the sweep, but Archive from the toolbar is the same state change. As it stands, a chat can show "Archived" while its Session is still running and drawing on the Budget. Either end the Session in the PATCH path, or make sure ticket 10 puts the "end it first" step in `Chats.update`, not only in the sweep.

#### 3. The chat view does not show the chat's Asks (low)
The spec's chat view Thread includes Asks, and an Admin is meant to see a chat's Ask "on the chat itself, not in their Needs you". `line()` in `Chats.tsx` renders only messages, progress, Session start/end and Digests, so the only way to answer a chat Ask is through Needs you. The Item view has the same limit today, so this is consistent with existing code. It does become necessary once ticket 06 sends chat Asks only to the owner's Needs you: an Admin will have no way to see them.

#### 4. `loadChats` on `core.hello` replaces the whole chat map (low)
`store.ts` `loadChats` calls `update({ chats: byId(...) })`, which drops any chats the Admin loaded through "Everyone's chats". After a reconnect, with the toggle still on, the list shows only the Admin's own chats until the toggle is switched off and on again. Fix: merge, or have `ChatsPage` refetch when the connection comes back. Relatedly, until ticket 06 filters SSE, `chat.opened`/`chat.updated` events for every person's chats reach every Shell's store. `ChatsPage` filters by owner, so nothing shows, but the data is in the browser.

#### 5. Owner column shows the raw owner id (low, already in the Digest)
"Everyone's chats" shows `ownerId` (`mia`, or `local`). The spec asks for chats "labelled with who opened them". An id is enough for Tailscale logins, but it is not a display name.

#### 6. Test gaps (low)
- Nothing asserts that a chat stays off the boards and Up next (for example, the Home board and Up next unchanged after a chat is opened and running).
- The phone-width test checks for sideways scroll only on `/chats`, not on the chat view, where the toolbar (title, Pin, Archive, and later Make it a Story) is the layout most likely to overflow.
- No API-level test for `PATCH` validation (`title: ""`, `pinned: "yes"` → 400) or for `all=1` returning 403 to a Member.

#### 7. Small code notes (nit)
- `ask-service.ts`: a `chat:<id>` Ask is accepted without checking that the chat exists. Only Sessions raise these, so it is harmless, but the 404 the other subjects get would be more consistent.
- `session-manager.ts`: skipping `planLocal` for chats (`project ? planLocal(...) : { stage }`) is a reasonable stop-gap, and it matches the spec's Further Notes on local-first.
- The merge's `CHAT_POLICY` spells out `worktree_read: 'allow'`, where the spec says "PROJECT_THREAD_POLICY with network allowed". The effect is the same, since read is allowed by default, but it is now a separate literal that can drift from the Project Thread policy.

### Scope notes
- This branch merges scratch-chat/06 (with 01) so it has a backend. The merge order into the Story branch has to keep that in mind.
- Make it a Story, Save as a note and the Story-link Thread entries are left to tickets 08/09, as the Digest says. That fits this ticket's wording.
