# Review: 02 Read roots and the chat Policy

Branch `kiln/ticket/scratch-chat/02`, commit c8612ca. Reviewed against the ticket and the spec's sections "Policy and reading Projects" and "Testing Decisions".

**Verdict: changes needed.** The Widget side is correct and tested. But nothing in the core sends `readRoots`, so a chat still can't read a Project, and the branch conflicts with ticket 01.

## What is right

- `SessionStart.readRoots?: string[]` is optional, so existing Agents and the fake Agent keep working.
- `requestFor` maps `Read`/`Glob`/`Grep`/`LS`/`NotebookRead` inside a read root to `worktree_read`. Writes there, and reads outside every root, fall through to `outside_worktree`, as the spec says. Both the PreToolUse hook and `canUseTool` pass the roots.
- `CHAT_POLICY` is `PROJECT_THREAD_POLICY` with `network: 'allow'`. Because it is a Stage layer, an Org `network: deny` wins, and the test shows this.
- No Permission Asks: the chat Policy has no `ask`. An unknown tool reaches the core as `other_commands`, which the Policy denies. Ticket 01's `onPermissionRequest` change denies unknown actions for chats.
- I ran `widgets/claude-code/test/read-roots.test.ts`. Both tests pass, each in under a second.

## Findings

### 1. (Major) The core never computes or sends `readRoots`
The ticket says: "Add readRoots to the Agent interface's Session start (every Project checkout plus the Knowledge store folder)". The branch adds the field but nothing fills it. Ticket 01's branch (696cc91) doesn't send it either: its session-manager diff never mentions `readRoots`. The Digest says ticket 01 will do it, but 01 is already built without it. As things stand, no ticket in the plan computes the roots (every registered Project's default-branch checkout plus the Knowledge store folder), so a chat Session can't read any Project.
**Fix:** once 01 is merged, compute the roots in the session manager's chat Session start, when the Session starts, as the spec says. Do this on this ticket, or as an explicit follow-up written into 01 or 03.

### 2. (Major) The core-side test through the fake Agent is missing
The ticket says "Test via the fake Agent and fake SDK". The spec's Policy test is through the fake Agent's permission requests: a read in a registered Project's checkout is allowed, and a write there, a write in the scratch folder, a shell command and an external write are denied. Only the fake-SDK half exists. This is blocked by 01 (there is no chat subject on this branch), but it needs to be tracked. `external_writes` isn't tested at either level.

### 3. (Major) Add/add conflict with ticket 01
Both branches create `packages/widget-sdk/src/scratch-chat.ts` and add the same export line to `packages/widget-sdk/src/index.ts`. 01's version is a superset: it has `chatThreadId`, `chatOfThread`, `ScratchChat` and the open-chat types, and its own `CHAT_POLICY`. The two `CHAT_POLICY` values are equal today. 01 spells the actions out, while 02 derives them from `PROJECT_THREAD_POLICY`; 02's form follows the spec's wording and stays in step if the Project Thread Policy changes. Whoever merges second must resolve this. Keep 01's file and use 02's `CHAT_POLICY` definition.

### 4. (Minor) The test file holds the process for 30 s
`runSession` races `done` against `new Promise((_, no) => setTimeout(..., 30_000))` and never clears that timer. Both tests pass in about 1 s, and then the file waits about 30 s for the timer. This explains the slow run in the implementer's Digest (measured: duration_ms 30905, with each test under 650 ms).
**Fix:** keep the timer handle and `clearTimeout` it in `t.after`, or call `.unref()` on it.

### 5. (Minor) Path rules don't apply to read-root reads the same way
Inside the worktree, the `worktree_read` detail is a relative path (`src/a.ts`). Inside a read root, it is an absolute path (`C:/.../project/src/a.ts`). Rules match on exact text or a prefix ending in `*`, so an Org or Stage rule such as `worktree_read` deny `secrets/*` won't match a read of another Project's `secrets/`. Today no layer for a chat has such rules, so nothing breaks yet. Either document that read-root details are absolute, or make them relative to the root (for example `<root name>/<rel>`) so rules can be written for them.

### 6. (Nit) Test coverage of the mapping
Only `Read` is exercised. Add one `Grep` or `Glob` with `path` inside a root, and one with no `path`. With no `path` they resolve to the scratch folder (`worktree_read`, allowed): fine, but worth pinning down. Also add a `Read` whose relative path climbs out of a root (`../other/x`).

## Not in scope here, noted
- Symlinks inside a Project checkout that point outside it are followed by `Read`, because `resolve` doesn't follow links. The worktree check has the same gap today, and this is unchanged.
