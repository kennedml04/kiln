# Grill: Scratch chat for one-off questions, with Make it a Story

Story: `kiln/story/scratch-chat` (Epic `kiln/epic/board-ux`). Grill Stage, 2026-11-05.

## The idea

A **Scratch chat** is a Session that belongs to no Project and no Item. You use it for a quick one-off question that isn't worth a card and shouldn't use up a working Session's context. A board button opens a new one. Each chat is its own small Thread, with no Stage, worktree or Exit. When a chat turns into real work, **Make it a Story** turns it into a grill-stage Story in a Project you pick. **Save as a note** keeps an answer in the Knowledge store.

## Decisions from the person (Asks)

1. **Web access: allowed.** A chat's Stage Policy is the Project Thread's read-only Policy with `network: allow`:
   - worktree write, known commands, other shell commands and external writes stay `deny`.
   - Reading registered Projects' files is allowed (see 7).
   - It is a Stage layer, so the Org Policy can still tighten network; nothing can loosen the rest.
2. **Make it a Story shows a draft first.**
   - The flow: the person presses Make it a Story and picks a Project and, optionally, a parent Epic in it. The chat Session drafts the Story: a title and a short `story.md` description summarising what was agreed (a summary, not the transcript).
   - The person can edit the draft, then chooses Accept or Cancel. Only on Accept does Kiln create the Item, as that person, through the Project's Tracker:
     - kind Story, Stage Grill, the chosen parent;
     - for the markdown Tracker, a Kiln-authored commit on the default branch, as with Items created from the Shell.
   - The new Story's Thread opens with a link back to the chat, and the chat shows a link to the Story.
   - The Story's first grill Session is seeded from `story.md` as usual, never from the chat transcript.
3. **Chat role default model: a local model if setup finds one, else Haiku.**
   - Setup's Models step lists a new `chat` role with this default, and the person can change it.
   - The chat draws on whichever Budget that model belongs to (local, or the subscription/metered Budget for Haiku).
4. **Archiving.**
   - An unpinned chat with no message for 7 days moves to an Archived list, where it can still be read and reopened. Reopening un-archives it.
   - 30 days after archiving it is deleted.
   - Pinned chats never archive.
5. **Chats count as the person's own attended use.**
   - They start at once without taking a capacity pool slot.
   - The pace rule and the subscription reserves don't block them, the same as Thread messages a person sends.
   - They still have the per-Session cap (turns and Budget share), the stall rule and the context alarm.
   - Usage is recorded per turn against the chat's Budget, as for any Session.
   - Stop all pauses chats too.
6. **Chats are private to their owner and Admins.**
   - On a multi-user install, only the person who opened a chat and Admins can see it. The Chats page shows each person their own chats; Admins can see all of them.
   - An Ask a chat raises goes only to its owner's Needs you.
   - After Make it a Story, the Story is visible as usual. Its link back to the chat opens only for the owner and Admins.

## Decisions taken in this grill (accepted by the person)

The griller proposed 7–12; the person reviewed them and accepted all six as written.

7. **What a chat can read:** every registered Project's files, read-only, from each Project's default-branch checkout (as the Project Thread does), plus the web.
   - Its Kiln tools are read-only across all Projects: list and read Items, artifacts and Digests.
   - It can draft a Story (for Make it a Story) and a note (for Save as a note). It cannot create anything itself; both need the person's click.
8. **Shape in the core:** a Scratch chat is modelled like the Project Thread.
   - It is an Item-shaped subject with its own id prefix (for example `chat:<id>`), so Sessions, Thread entries, Asks and usage work unchanged.
   - Its Stage, role (`chat`) and Policy are Kiln's own, not a Workflow's.
   - Policy layers are Org plus the chat Stage layer; there is no Project layer.
   - The chat's Session runs in an empty scratch folder in Kiln's data folder, never in a Project checkout.
9. **One chat, one live Session.**
   - Messages go to the running Session.
   - When it goes idle it writes a Digest. Coming back after the prompt cache has expired starts a fresh Session from the chat's Digests (spec rule 35).
   - Chat Digests stay in runtime data, not the Knowledge store, and are deleted with the chat. What's worth keeping goes out through Save as a note or Make it a Story.
10. **Where it shows in the Shell:**
   - a "New chat" button in the persistent header;
   - a Chats page listing recent chats (pinned first, then by last message) with an Archived tab;
   - chats are not on the boards and not in Up next;
   - an Ask a chat raises appears in its owner's Needs you, labelled with the chat's title.
11. **Save as a note:**
    - Any assistant reply in a chat has a "Save as a note" action. It writes a markdown note (the question and that answer, with frontmatter: title, date, source chat) into the Knowledge store's notes folder.
    - The person can edit the title before it saves.
12. **Roles:** Members and Admins can open chats and use Make it a Story. Viewers can't open chats. Every chat records who opened it.
    - Who can see a chat is decision 6 above.

## Open

- **Local-first.** When the local-first Story lands, the `chat` role's routing should follow it. Until then the default from decision 3 stands.
- The spec should add **Scratch chat** to `GLOSSARY.md`: a Session with no Project or Item; avoid "scratch card" and "quick chat".
