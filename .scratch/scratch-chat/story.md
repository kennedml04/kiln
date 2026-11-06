---
title: Scratch chat for one-off questions, with Make it a Story
epic: board-ux
stage: tickets
blocked-by: []
---
Quick one-off questions often turn into real work, but making a card for each one is too much, and asking them inside a working Session uses up its context. A **Scratch chat** is a Session that belongs to no Project and no Item: a button on the board opens one, each chat is its own small Thread, and it has no Stage, worktree or Exit. It is read-only by default (it may read registered Projects' files) and runs on a `chat` role whose default model is cheap, or local first once the local-first Story lands. When a chat turns into work, **Make it a Story** asks which Project, writes a short grill-stage `story.md` from what was agreed (a summary, not the transcript) and links the Story's Thread back to the chat. Recent chats are listed and can be reopened; old ones archive after a few days unless pinned. An optional **Save as a note** writes an answer worth keeping into the knowledge folder.

## To grill

- Read-only, or edits allowed in a throwaway scratch worktree?
- Which Projects can a chat see: all registered ones, or one picked when it opens?
- What Make it a Story carries over: the summary only, or also links to files and the chat?
- Budgets: does a chat draw on the role's Budget like any Session, and does it get its own turn cap?
- Where the button lives (board header, Needs-you area, phone layout).
