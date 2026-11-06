# Spec: Scratch chat for one-off questions, with Make it a Story

Status: ready-for-agent

Sources: `.scratch/scratch-chat/story.md`, `.scratch/scratch-chat/grill.md` (the grill decisions of 2026-11-05, numbered 1–12 below as they are there), and the code as of branch `kiln/story/scratch-chat` (0c03a8f). The Project Thread (`packages/widget-sdk/src/project-thread.ts`, `threadSubject` in `packages/core/src/flow/session-manager.ts`) is the model this Story copies.

## Problem Statement

- A quick one-off question ("how does the Tracker pick a key?", "what's a good heatset size for M3?") has nowhere to go. Making a card for it is too much: the card needs a Project, a Stage, a worktree and an Exit.
- Asking it inside a working Session uses up that Session's context and pulls it off its task.
- The Project Thread is close, but it belongs to one Project, has one long Thread per Project, and can't look across Projects or at the web.
- Questions like these often turn into real work. Today that means retyping what was agreed into a new Story by hand.
- A good answer is lost once the conversation scrolls away, unless someone copies it out.

## Solution

A **Scratch chat** is a Session that belongs to no Project and no Item. A **New chat** button in the persistent header opens one. Each chat is its own small Thread with no Stage, worktree or Exit, in Kiln's own Item-shaped subject `chat:<id>`, the way the Project Thread uses `project:<id>`.

A chat can read every registered Project's files and the web, and use read-only Kiln tools across all Projects. It cannot change anything. It runs on a new `chat` role whose default model is a local one if setup finds one, else Haiku. Chats count as the person's own attended use: they start at once, outside the capacity pools and the pace and reserve rules, but keep the per-Session caps.

When a chat turns into work, **Make it a Story** asks for a Project (and optionally an Epic), has the chat draft a title and a short `story.md`, lets the person edit it, and creates a grill-stage Story on Accept. The Story and the chat link to each other. **Save as a note** writes a question and its answer into the Knowledge store. Chats are private to their owner and Admins. Unpinned chats archive after 7 idle days and are deleted 30 days after that.

## User Stories

### Opening and using a chat

1. As a Member, a **New chat** button in the persistent header opens a new, empty chat, on desktop and on my phone.
2. As a Member, my first message starts the chat's Session at once, even when every capacity pool is full or the subscription is ahead of pace.
3. As a Member, the chat can read any registered Project's files (from its default branch), look things up on the web, and read Items, artifacts and Digests in any Project.
4. As a Member, the chat can never edit files, run shell commands, write to anything outside Kiln, or create Items or notes by itself.
5. As a Member, my later messages go to the chat's running Session. If I come back after its prompt cache has expired, the chat carries on in a fresh Session seeded from its own Digests, not the raw transcript.
6. As a Member, a chat is titled from my first message, and I can rename it.
7. As a Member, an Ask the chat raises appears in my Needs you, labelled with the chat's title.
8. As a Viewer, I don't see the New chat button, and the API refuses to open a chat for me.

### Make it a Story

9. As a Member, **Make it a Story** in a chat asks me for a Project and, optionally, an Epic in it.
10. As a Member, the chat then drafts a title and a short `story.md` description that sums up what we agreed, not the transcript.
11. As a Member, I can edit the draft's title and description, then choose Accept or Cancel. Cancel creates nothing.
12. As a Member, Accept creates a grill-stage Story in that Project, under the Epic if I picked one, as me, through the Project's Tracker. For the markdown Tracker that is a Kiln-authored commit on the default branch, as for Items created from the Shell.
13. As a Member, the new Story's Thread opens with a link back to the chat, and the chat shows a link to the Story.
14. As a Member, the Story's first grill Session is seeded from its `story.md`, as every Story's is, and never sees the chat transcript.
15. As a Member, I can use Make it a Story more than once in the same chat, and each Story is linked.

### Save as a note

16. As a Member, every assistant reply in a chat has **Save as a note**. It saves my question and that reply as a markdown note in the Knowledge store's notes folder, with a title, the date and the source chat in its frontmatter.
17. As a Member, I can edit the note's title before it saves.

### Finding chats again

18. As a Member, a **Chats** page lists my chats, pinned first and then by last message, with an Archived tab.
19. As a Member, I can pin and unpin a chat. Pinned chats never archive.
20. As a Member, an unpinned chat with no message for 7 days moves to Archived, where I can still read it. Reopening it, or sending it a message, un-archives it.
21. As a Member, an archived chat is deleted 30 days after it was archived, with its Digests and scratch folder. Notes and Stories made from it stay.
22. As a Member, chats never appear on the boards or in Up next.

### Privacy, Budgets and safety

23. As a Member on a multi-user install, only I and the Admins can see my chats: the Chats page, their Threads, their Asks and the link back from a Story made from one.
24. As an Admin, the Chats page can show every person's chats, labelled with who opened them.
25. As the owner, a chat's usage is recorded per turn against the Budget of the model it runs on, and shows in usage views as "Scratch chats".
26. As the owner, a chat still stops at the per-Session turn and Budget caps, the stall rule and the context alarm, as any Session does.
27. As the owner, Stop all pauses running chats too, and a new chat message while Stop all is on is refused with the reason.
28. As the owner, setup's Models step lists a `chat` role, suggests a local model if it found one and Haiku otherwise, and lets me change it. Settings → Models lets me change it later.

## Implementation Decisions

### The chat subject (decision 8)

- **`packages/widget-sdk/src/scratch-chat.ts`**, beside `project-thread.ts`:
  - `chatThreadId(id)` → `chat:<id>`, and `chatOfThread(threadId)` → the id or undefined. The id is a random URL-safe id with no `/` or `:`, so it never collides with an Item id (`<projectId>/<key>`) or a Project Thread id.
  - `CHAT_KIND`, `CHAT_STAGE` and `CHAT_ROLE`, all `chat`.
  - `CHAT_POLICY`: `PROJECT_THREAD_POLICY` with `network: 'allow'` (decision 1). Everything else stays `deny`.
  - The `ScratchChat` record type for the API: `id`, `title`, `ownerId`, `createdAt`, `lastMessageAt`, `pinned`, `archivedAt?`, `stories` (the Item ids made from it), `running`.
- **Runtime record:** a `chats` table in the core's SQLite: id, title, owner, created, last message, pinned, archived, and the linked Story ids. Chats are runtime data. They are not in any Tracker or in the Knowledge store (decision 9).
- **Session subject:** the session manager resolves `chat:<id>` to an Item-shaped stand-in, like `threadSubject`: kind `chat`, stage `chat`, no Project, title the chat's title. So Sessions, Thread entries, Asks and usage records work unchanged. Code that reads `session.projectId` gets an empty value for a chat and must not look up a Project; each such place (`kiln-tools.ts` scoping, the audit target, the usage roll-ups, `seedArtifacts`) gets a chat branch like its Project Thread branch.
- **Stage:** Kiln's own `CHAT_STAGE` (`{ id: 'chat', name: 'Scratch chat', role: 'chat', policy: CHAT_POLICY }`), never a Workflow's. It has no Exit and no worktree.
- **Model:** the `chat` role's model and fallback come from the install's role settings (`settings.roles.chat`), the same setting the Models step writes. There is no Project Workflow to look in.
- **Working folder:** each chat's Session runs in `<dataDir>/chats/<id>/`, an empty folder Kiln creates. It is never a Project checkout and never a git repo.

### Policy and reading Projects (decisions 1 and 7)

- A chat's effective Policy is the Org layer plus the chat Stage layer. There is no Project layer. The Org layer can still tighten `network`; nothing can loosen the rest.
- **Read roots.** The Agent interface's Session start gains `readRoots: string[]`: folders a Session may read but never write. For a chat, they are every registered Project's checkout path (the default-branch checkout the Project Thread reads), plus the Knowledge store folder. The Claude Code Agent's permission check (`widgets/claude-code/src/permissions.ts`) treats a read tool (`Read`, `Glob`, `Grep`, `LS`, `NotebookRead`) whose target is inside a read root as `worktree_read`. Any other tool on a path there is still `outside_worktree`, which the chat Policy denies.
- Read roots are computed when the Session starts. A Project registered while a chat runs is readable from that chat's next Session.
- Web search and web fetch map to `network`, which the chat Policy allows.
- **No "always allow" in a chat.** A permission request a chat's Session makes that the Policy doesn't allow is denied, as for the Project Thread. It does not raise a Permission Ask. Chats exist for quick questions, and a denied tool is the right answer to "can you edit this?".

### Kiln tools in a chat (decision 7)

- Read-only across all Projects:
  - list the registered Projects;
  - list a Project's Items;
  - read an Item, its artifacts and its Digests.
- `raise_ask` (a Question or Decision Ask on the chat; Permission Asks don't arise, see above) and `write_digest` for the chat itself.
- `draft_story({ title, description })` and nothing else that writes. It is only accepted while a Make it a Story draft is pending for this chat (see below), and it fills that draft. It never creates an Item.
- Chats do not get the Project Thread's proposal tools (`create_items`, `reorder_queue`).

### Sessions, Digests and seeding (decision 9)

- One chat has at most one live Session. A message goes to it if it is running (`sessions.message`). Otherwise Kiln starts a new Session for the chat.
- When the chat's Session goes idle, it writes a Digest. A fresh Session after the prompt cache has expired is seeded from the chat's Digests plus the new message (spec rule 35), never from the transcript.
- **Chat Digests are runtime data,** written to `<dataDir>/chats/<id>/digests/` in the same markdown format as Knowledge store Digests, and never to the Knowledge store. The Knowledge store interface is not used for them. They are deleted with the chat.
- The context alarm works as for any Session: it pauses, writes a Digest and continues fresh.

### Starting, Budgets and caps (decisions 3 and 5)

- **Attended use.** A chat message starts its Session at once, outside the scheduler's queue and capacity pools, the same way a Project Thread message does today (`packages/core/src/flow/routes.ts`). It is marked attended, so the pace rule and subscription reserves don't block it. A local model's `gpu` pool claim does not apply to it either.
- **Caps that still apply:** the per-Session turn cap and Budget share, the stall rule and the context alarm. Breaching a cap pauses the chat's Session and raises a blocking Ask in its owner's Needs you, as for any Session.
- **A Budget's period limit** (the monthly credits, or the weekly window used up) still pauses a chat drawing on that Budget. "Attended" only lifts the pace rule and reserves, which exist to protect the person's own use.
- **Stop all** pauses running chat Sessions. While it is on, a chat message is refused with 409 and "Stop all is on", as Project Thread messages are.
- **Usage** is recorded per turn against the Budget of the chat's model, with the chat as its subject and no Project. Roll-ups show it under a "Scratch chats" row wherever they group by Project, and it counts toward the Budget's day, week and month like any other use. It does not count toward any Project's per-day cap.

### The `chat` role in setup (decision 3)

- Setup's role list (`defaultRoles` in `packages/core/src/setup/setup.ts`) gains `chat` as a Kiln role, beside the default Workflow's roles. `checkRoles` accepts it.
- `suggestRoles` (`packages/shell/src/role-defaults.ts`) gets a rule for `chat`: a model in a local Budget if any, else the lightest (Haiku-tier) model, else the default mid model. The person can change it there and in Settings → Models.
- An install set up before this Story has no `chat` role. Opening a chat then fails with "Choose a model for the chat role in Settings → Models", and Settings shows the suggestion.
- **Local-first.** Until the local-first Story's role modes apply to Kiln's own roles, the `chat` role is a plain model choice. See Further Notes.

### Make it a Story (decision 2)

1. The person presses **Make it a Story** and picks a Project, and optionally an Epic in it (the Epic list comes from that Project's Items).
2. `POST /api/chats/:id/story-draft { projectId, parentId? }` opens a pending draft on the chat and sends the chat's Session a Kiln-written message. The message asks it to call `draft_story` with a title and a short `story.md` description summarising what was agreed, not the transcript, written for a griller who hasn't seen the chat. If no Session is live, this starts one from the chat's Digests, as a message would.
3. The Shell shows the draft in an editable dialog when `draft_story` fills it (an SSE event on the chat). It shows a spinner until then, and a Cancel button throughout.
4. **Accept**, `POST /api/chats/:id/story { projectId, parentId?, title, description }`, creates the Item through the Project's Tracker as the accepting person: kind Story, Stage Grill, the chosen parent. This uses the same create path as Items created from the Shell, so the markdown Tracker makes a Kiln-authored commit on the default branch. The description is the `story.md` body.
5. Kiln then records the link both ways, as runtime Thread entries:
   - `item.from_chat { chatId }` on the new Story's Thread, shown as the first entry ("Made from a Scratch chat", linked);
   - `chat.story_made { itemId }` on the chat's Thread, linked to the Story.
   
   The Story's `story.md` carries no chat reference: the link is runtime only, so it disappears from view when the chat is deleted, and the Tracker never holds private chat ids.
6. **Cancel**, or a draft left pending for 30 minutes, drops the draft. Nothing is created.
- Only Members and Admins can call these routes, and only on a chat they can see. The Project and parent are checked as for any Item creation.
- The Story's first grill Session is seeded as usual, from `story.md`, its Epic and Digests. The chat's transcript and Digests are never in its seed.

### Save as a note (decision 11)

- `POST /api/chats/:id/notes { entryId, title }` takes the assistant reply `entryId` and the person's message just before it. No model call is made: the note is that question and that answer, verbatim.
- The note is written by a new `writeNote` on the Knowledge store interface into its notes folder (`notes/` in the markdown store), as `<date>-<slug>.md`, with frontmatter `kiln: note`, `title`, `date`, `source: chat:<id>` and `author`. A name clash gets a numeric suffix.
- The Shell opens a small dialog with the title prefilled from the chat's title, editable, and Save and Cancel buttons. On save, the reply shows "Saved as a note", with the note's path.
- Notes are the person's. They stay when the chat is deleted, and their `source` then points at nothing.

### Archiving and deletion (decision 4)

- A periodic sweep (hourly, and at core start) archives every unpinned, unarchived chat whose last message is more than 7 days old. It deletes every chat archived more than 30 days ago.
- Archiving only sets `archivedAt`. A live Session for an archived chat is ended first; it will have written its Digest when it went idle.
- Reopening an archived chat from the Archived tab, or sending it a message, clears `archivedAt`. Pinning an archived chat also clears it.
- **Deletion** removes the chat's row, its Thread entries, its open and answered Asks, its pending draft, and `<dataDir>/chats/<id>/` (Digests included). Usage records stay, so Budget history doesn't change. Audit log entries stay, since the log is append-only. Stories and notes made from it stay.
- The sweep reads the injectable clock, so tests can move time on.

### Privacy and roles (decisions 6 and 12)

- Every chat records its owner, the person who opened it.
- **Who can see a chat:** its owner and Admins. Every `/api/chats/...` route, and every Thread, Ask and Session route that names a `chat:` subject, returns 404 to anyone else, so a chat's existence isn't leaked.
- **Events:** SSE events whose subject is a chat go only to its owner's and Admins' connections.
- **Needs you:** an Ask on a chat goes only to its owner's Needs you. An Admin sees it on the chat itself, not in their Needs you.
- **Story link:** the `item.from_chat` entry on a Story's Thread is visible to anyone who can see the Story. It opens the chat only for the owner and Admins; anyone else sees "Made from a Scratch chat" with no link.
- **Roles:** Members and Admins can open chats, message them, use Make it a Story and Save as a note on chats they can see. Viewers can't open or message chats. Every mutating chat request is checked against the role and written to the audit log with the person as actor.
- Local mode has one person, the Admin, so all of this is invisible there.

### Core API

All under `/api/chats`, Member or Admin unless noted:

- `GET /api/chats?archived=0|1&all=0|1`: the caller's chats (with `all=1`, every chat, Admin only), pinned first, then by last message.
- `POST /api/chats`: open a chat; returns its id. The first message can come with it.
- `GET /api/chats/:id`, `PATCH /api/chats/:id { title?, pinned?, archived? }`.
- `GET /api/chats/:id/thread`, `GET /api/chats/:id/digests`, `POST /api/chats/:id/messages { text }`.
- `POST /api/chats/:id/story-draft`, `DELETE /api/chats/:id/story-draft`, `POST /api/chats/:id/story`.
- `POST /api/chats/:id/notes`.

There is no route to delete a chat by hand. Deletion is only by the archive rule. A person who wants a chat gone sooner can archive it (`archived: true`), and it is deleted 30 days later.

### Shell (decision 10)

- **Header:** a **New chat** button in the persistent header, next to Stop all, hidden for Viewers. On the phone layout it is an icon button in the same header. It opens a new chat view focused on the message box. The chat is created on the first message, so opening and leaving makes no empty chat.
- **Chat view:** the Thread (messages, Session starts and ends, Digests, Asks, Story links), a message box, and a toolbar with the title (click to rename), Pin, Make it a Story and Archive. Each assistant reply has Save as a note.
- **Chats page:** reached from the header's menu. It lists the caller's chats, pinned first and then by last message, each with its title, last message time and a pin mark. An Archived tab lists archived chats. Admins get an "Everyone's chats" toggle that adds an owner column.
- Chats are not on any board and not in Up next.
- **Needs you:** a chat's Ask shows the chat's title where an Item's would show the Item's, and links to the chat.
- **Story Thread:** the `item.from_chat` entry renders as the first line of the Story's Thread.
- The new views follow the existing dark-first theme.

## Testing Decisions

All tests drive Kiln from outside with `startTestKiln(t)` and the fake Agent, and check API responses, SSE events, files in the Project repo and the Knowledge store, and git state.

- **Opening and messaging:** a chat starts at once when the capacity pool is full and when the fake subscription readings are ahead of pace or in the reserve. A second message goes to the same Session. After a cache expiry (moved clock), the next message starts a fresh Session whose seed holds the chat's Digest and no transcript.
- **Caps:** a chat hitting the turn cap pauses with a blocking Ask in its owner's Needs you. Stop all pauses a running chat and refuses a new message with 409.
- **Policy:** through the fake Agent's permission requests, a read inside a registered Project's checkout is allowed; a write there, a write in the scratch folder, a shell command and an external write are denied; `network` is allowed, and denied when the Org Policy denies it. The Claude Code permission mapping for read roots gets unit-level tests through the fake SDK, as its existing permission tests do.
- **Kiln tools:** a chat can list Projects and read Items, artifacts and Digests across two Projects. `draft_story` is refused when no draft is pending. The proposal tools are absent.
- **Make it a Story:** the full flow with the fake Agent calling `draft_story`. Accept with an edited title creates a grill-stage Story under the chosen Epic, as a Kiln-authored commit on the default branch, with the edited text in `story.md`. Both link entries appear. Cancel creates nothing and makes no commit. The Story's first grill Session's seed contains nothing from the chat.
- **Save as a note:** writes `notes/<date>-<slug>.md` in the Knowledge store with the question, answer and frontmatter. A clashing name gets a suffix.
- **Archiving:** with the clock moved, an idle unpinned chat archives at 7 days, and a pinned one doesn't. Reopening un-archives it. 30 days after archiving, the chat and its folder are gone, while its usage records, the Story made from it and its note remain.
- **Privacy:** with two Members and an Admin, Member B gets 404 on Member A's chat routes, Thread and Asks, receives none of its SSE events and doesn't see its Asks in Needs you. The Admin sees all of them with `all=1`. A Viewer is refused on `POST /api/chats`. The Story link opens the chat only for its owner and the Admin.
- **Setup:** the Models step offers `chat`, suggesting the local model when a fake local server is found and Haiku otherwise. Opening a chat with no `chat` model set gives the Settings message.
- **Shell:** Playwright drives New chat from the header (desktop and phone width), a message and reply, rename and pin, Make it a Story through to the Story's Thread and back, Save as a note, and the Chats page with its Archived tab.

## Out of Scope

- Edits of any kind from a chat, including a throwaway scratch worktree.
- Picking a single Project when a chat opens. A chat sees every registered Project.
- Sharing a chat with another non-Admin person, or making it public.
- Deleting a chat by hand before the archive rule does it.
- Carrying the transcript, or file links, into the Story. The Story gets the summary only.
- Searching across chats.
- A chat creating anything without a person's click.
- Local-first routing (escalation, variants, shadow review) for the `chat` role. It follows the local-first Story; see below.

## Further Notes

- **Local-first.** When the local-first Story's role modes land, the `chat` role should get a mode like any other role. Because a chat has no check to fail, "local first" for chat can only mean "use the local variant"; escalation doesn't apply. That Story or a follow-up should settle it. Until then, decision 3's default stands.
- **Glossary.** This Story adds **Scratch chat** to `GLOSSARY.md`: a Session that belongs to no Project and no Item, for a one-off question. _Avoid_: scratch card, quick chat.
- **Read roots** are a small, general addition to the Agent interface. A later Story could use them to let the Project Thread read linked Projects.
- **Suggested ticket order:**
  1. The chat subject, `chats` table, scratch folder and Kiln Stage; `POST /api/chats` and messages starting attended Sessions; caps and Stop all.
  2. Read roots in the Agent interface and the Claude Code permission mapping; the chat Policy.
  3. Chat Kiln tools (read-only across Projects).
  4. Chat Digests in runtime data, and seeding fresh Sessions from them.
  5. The `chat` role in setup and Settings → Models.
  6. Privacy: route checks, SSE filtering, Needs you routing.
  7. The Shell: header button, chat view, Chats page.
  8. Make it a Story (draft, edit, Accept, links).
  9. Save as a note and the Knowledge store's `writeNote`.
  10. Archiving and deletion sweep.
