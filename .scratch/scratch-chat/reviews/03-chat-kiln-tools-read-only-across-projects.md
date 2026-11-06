# Review: 03 Chat Kiln tools (read-only across Projects)

## Round 2 (2026-11-05)

Commit reviewed: 0f6a3a6. This is 57b09e3 again, rebased onto the merge of ticket 02 (f879ec3). The last implementing Session changed nothing, so **none of round 1's fixes has been made.** Typecheck passes (`tsc --noEmit`, exit 0). I didn't re-run the full suite because the code hasn't changed since the implementer's passing run.

Verdict: **send back to Implementing.** Findings 1 and 2 are still open and small. Two new things to know: the branch will conflict with ticket 01 (finding 6), and there's an audit-target mismatch (finding 7).

### Still open from round 1

- **1. The chat's raise_ask offers Permission Asks (should fix).** This is still at `kiln-tools.ts` CHAT_TOOLS `raise_ask`, which uses `ASK_PROPERTIES` with every `ASK_TYPES` value. Restrict it to `['question', 'decision']` and refuse `permission` in `chatScope.raiseAsk`.
- **2. The borrowed read tools point at read_project (should fix).** `kiln-tools.ts:200` still has `ITEM_ID` = "An Item id from read_project.", and `:217` still has "One of the Project's Items". A chat has neither. Give it chat descriptions that say ids come from list_items.
- **3. The `as unknown as Tool<ChatToolsScope>` cast (nice to have).** Still there. A shared `ItemReadScope` would remove it and fix finding 2 at the same time.
- **4. No tests (open, blocked on ticket 01).** These need ticket 01's `POST /api/chats` first. When 01 lands, add an outside-in test with the fake Agent: list_projects and read_item/read_artifacts/read_digests across two Projects; draft_story refused with no pending draft; create_items and reorder_queue absent from `tools/list`.
- **5. Dependencies.** `asks.raise` (`asks/ask-service.ts:197`) has no chat branch, so `chat:<id>` gets 404 (tickets 01/06). recordDigest writes to the Knowledge store (ticket 04). Ticket 02 has merged, but `onPermissionRequest` (`session-manager.ts:737`) still sets `thread` from `projectOfThread` only. A chat's unknown action would therefore raise a Permission Ask instead of being denied, which the spec rules out. Neither 02 nor this ticket fixed it, so it should be fixed here or in 01. It's a one-line change: `|| chatOfThread(info.itemId) !== undefined`.

### New in round 2

- **6. This branch will conflict with ticket 01 (must resolve before merge).** `kiln/ticket/scratch-chat/01` (696cc91, in review) also adds `chatThreadId`, `chatOfThread`, `ScratchChat`, `CHAT_KIND/STAGE/ROLE` and its own `CHAT_POLICY` to `packages/widget-sdk/src/scratch-chat.ts`. It also changes `session-manager.ts` and `kiln-tools.ts`. Both tickets define the same exports in different places in the file, so the merge will produce duplicate or conflicting declarations. Whichever ticket merges second has to keep a single copy. Prefer 01's, since 01 owns the chat subject, and rebase this ticket's tool layer onto it. That is also the point where the finding 4 tests become possible, so it makes sense to merge 01 first and then rebase 03.
- **7. The audit target is inconsistent for chats (nice to have, may belong to 01).** `kilnToolsTarget` audits chat tool calls as `chat:<id>`. The session manager's `auditTarget` (`session-manager.ts:258`) has no chat branch, so permission decisions for the same Session are audited as `item:chat:<id>`. Add a chat branch there to match.

### Checked and fine (unchanged from round 1)

- The tool list matches the Ticket: list_projects, list_items, read_item, read_artifacts, read_digests, raise_ask, draft_story and write_digest. No create_items or reorder_queue.
- draft_story is refused unless the `draftStory` dep is wired and accepts the draft. Empty input is refused before the dep is called.
- `chatOfThread` can't collide with Item ids or Project Thread ids.
- `chatScope` reads any Item through `work.item`, and reads artifacts from that Item's own Project checkout.
- A proposal through the chat's raise_ask is refused (`asks/ask-service.ts:202`).

---

## Round 1

Commit reviewed: 57b09e3.

1. The chat's raise_ask offered Permission Asks. Should fix.
2. read_item, read_artifacts and read_digests were borrowed from the Project Thread and point at read_project. Should fix.
3. The `as unknown` cast hides type drift. Nice to have.
4. No tests. Blocked on ticket 01.
5. raise_ask, write_digest and permission handling fail for chats until tickets 01, 02, 04 and 06 land.
