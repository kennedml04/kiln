# Review: 02 Move command classifier into widget-sdk

Branch `kiln/ticket/pi-agent-widget/02`, merge base 4e02fb8 on master. Ticket commits: 6b4d606 (the move) and 6cf85cf (the loader subpath).

**Verdict: approve.** Two findings should be fixed before the Pi Widget (Ticket 03/04) builds on this. Neither changes Claude Code's behaviour. The rest are nits.

## What I checked

- `npm ci` then `npm test` on this branch: check, Shell build, typecheck, then 556 tests. 543 passed, 0 failed, 13 skipped (the opt-in ones). Exit 0.
- `widgets/claude-code/src/permissions.ts` was moved with `git mv` to `packages/widget-sdk/src/tool-classifier.ts` and is now exported as `@kiln/widget-sdk/tool-classifier`. It stays out of the browser-safe index because it imports `node:os` and `node:path`. That is the right call: the Shell imports the index.
- `widgets/claude-code/src/agent.ts` now imports `SCRATCH`, `ownFolderOf`, `requestFor` and `ToolPlace` from the subpath. Nothing still refers to the old file, apart from historical scratch specs and `.kiln/policy.json` rule history.
- `packages/core/src/widgets/sdk-loader.ts` points the subpath at the core's own copy, the same way it already does for the bare `@kiln/widget-sdk`. Without this, a Widget installed from git (no `node_modules/@kiln`) could not load the classifier. `install-from-git.test.ts` passes.

### Claude Code's behaviour is unchanged

I compared the old and new `requestFor` line by line. The hard-coded sets became `CLAUDE_CODE_TOOLS: ToolVocabulary`, and that is the default for the new last parameter `vocab`. Claude Code passes no `vocab`, so it gets the same sets:

- `HARMLESS` became `harmless`, with the same 21 names.
- `AROUND_KILN` became `aroundKiln`, with the same three names and messages.
- `READS` and `WRITES` became `reads` and `writes`, unchanged.
- The literals `Bash`, `PowerShell`, `Monitor` became `shells`, `WebFetch` became `fetches`, and `WebSearch` became `searches`.
- `mcp__kiln__` became `kilnPrefix`, and `mcp__` became `mcpPrefix`.

The order of the checks is unchanged.

There is one tiny difference. `AROUND_KILN[tool]` (a truthy lookup) became `Object.hasOwn(aroundKiln, tool)`. Before, a tool named `constructor` or `toString` hit an inherited property and was denied with a garbled message. Now it falls through to "unknown tool, ask". That is a fix, and no real tool has those names.

### Agent interface (`packages/widget-sdk/src/agent.ts`)

Three comments changed and no types changed:

- `kilnTools`: an Agent without an MCP client can call the HTTP endpoint directly.
- `mcpServers`: an Agent with no MCP client ignores it.
- `usedCredits`: Agents with no plan report no quota readings.

I read the whole interface against the Pi spec (01, decisions 2 to 10) and found no Claude-only assumption in the *types* that Pi would have to work around:

- `ModuleMcpServer` is plain MCP stdio, http or sse.
- `usage` has the optional `costUsd`, `contextWindow` and `subagent`.
- `cacheLifetimeMs` and `models[].local` exist.
- `AgentMessage` and `AgentCommand` cover steer/follow-up, interrupt, resume and stop.

So comment-only is acceptable here. But see finding 2.

## Findings

### 1. Claude Code-specific helpers now live in the shared SDK with generic wording (should fix)

`ownFolderOf(transcriptPath, sessionId)` parses Claude Code's transcript layout (`<projects>/<slug>/<session id>.jsonl`). The diff edits the comments on `ToolPlace` and `SCRATCH` to say "an Agent". But `ownFolderOf`'s doc still says "the Session's own Claude Code folder", and `ToolPlace.ownFolder` still says "where Claude Code saves long tool results". The shared module's header says it is "Shared by every Agent Widget". A Pi Widget author would read `ownFolderOf` as part of the shared contract.

Either:

- move `ownFolderOf` back into `widgets/claude-code` (it is only a parser of Claude's hook input, not classification), or
- keep it and label it clearly as Claude Code-only.

I'd move it.

### 2. `kilnTools` comment promises something the endpoint doesn't offer (should fix)

The new `kilnTools` comment says: "An Agent without an MCP client can call its HTTP endpoint directly". But `KilnToolsEndpoint` is documented a few lines lower as "an MCP server over Streamable HTTP". There is no plain REST surface. "Calling it directly" means speaking MCP JSON-RPC by hand. The `mcpServers` addition ("reaches Kiln's tools through `kilnTools` some other way") is just as vague.

Pi has an MCP client anyway (spec decision 4, `createMcpExtension`), so neither sentence describes a real Agent today. Either:

- drop both sentences, or
- say plainly that an Agent must speak MCP over Streamable HTTP to reach Kiln's tools.

Unclear contract text in the SDK is what the next Widget author builds against.

### 3. Branch carries three commits outside the Ticket (note for merge)

`master..HEAD` also has these commits:

- 56aa5e6: scratch-file wording in `policy-path-leak`
- fab13db: a wait in the `role-modes` test
- 25df7e0: `npm test` concurrency raised to 8 in `package.json`

None of them touches the classifier. 25df7e0 changes how every later run of the suite behaves. These should go to master on their own, or the merge note should say they ride along, so they aren't lost or surprising.

### 4. `requestFor` now takes nine positional parameters (nit)

`vocab` is the ninth. The Pi Widget, to pass its vocabulary, has to spell out every default before it: `skillFolders`, `readRoots`, `SCRATCH`, `where`. That is easy to get wrong in order. Two options:

- an options object for the trailing parameters, or
- a `classifierFor(vocab)` that returns a bound `requestFor`.

Either would make the second caller cleaner. Not worth blocking on; Ticket 04 can do it when it adds the Pi caller.

### 5. No test exercises a non-default vocabulary (nit, for Ticket 04)

Coverage of the classifier is still only through the Claude Code Widget's tests, all with `CLAUDE_CODE_TOOLS`. Nothing yet checks that:

- a vocabulary without `mcpPrefix` treats `mcp__x` as unknown (ask), or
- `shells` with a different tool name routes to `shellRequest`.

The parent spec's acceptance item "Claude Code and Pi Widgets give the same Policy action for the same command" belongs to Ticket 04/07. Note it there rather than here.

## Checked against the Ticket

| Ticket asks | Where | OK |
|---|---|---|
| Classifier moves into `@kiln/widget-sdk` | `packages/widget-sdk/src/tool-classifier.ts`, subpath export, and the loader in `sdk-loader.ts` | yes |
| Claude Code Widget uses it | `widgets/claude-code/src/agent.ts:10` | yes |
| Claude Code's behaviour doesn't change | Same sets as defaults, same order of checks. Suite green (543/0/13) | yes |
| Fix Claude/OpenCode-only assumptions in the Agent interface itself | No type-level assumption found. Comment-only edits, one of them misleading (finding 2) | mostly |
