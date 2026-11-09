# Review: 03 Local Sessions in the Claude Code Agent

Reviewed: merge 57ec80a (local-first-03: 7667b0a, 8dc14d1) against its first parent 1e53341, on 2026-11-05.

**Verdict (fourth pass, 51619ed): changes requested; see finding 8.** First-pass verdict: accept. Every box the Ticket keeps is met, and the last box moved to ticket 14 as decided. None of the findings below blocks the Ticket. Finding 1 is worth fixing soon, because a test should prove the main safety claim.

Tests run here after `npm ci`: `node --test widgets/claude-code/test/local-session.test.ts` gave 7 passed, 0 failed, 1 skipped (the `KILN_REAL_LOCAL` real check). I did not run the full `npm test` again; the implementing Digest reports 463 passed, 0 failed, 14 skipped.

## Second pass: after the master merge (f707a5d)

Reviewed again on 2026-11-05, at f707a5d (master merged into this branch).

- The merge changed no code. `git diff a29db81 f707a5d -- packages widgets` is empty. The merge brought in `.kiln/policy.json`, tracker files and `GLOSSARY.md` only. So the code under review is the same as in the first pass, and the branch's code diff against master is still the 12 files listed by `git diff --stat master...HEAD`.
- Ran `npm ci`. Then `node --test widgets/claude-code/test/local-session.test.ts` gave 7 passed, 0 failed, 1 skipped (`KILN_REAL_LOCAL`), and `npm run typecheck` is clean. I did not run the full `npm test`.
- No commit since the first pass addresses findings 1 and 2. They still stand as written below, with the same severity.

**Verdict still: accept.**

## Third pass: after the second master merge (a3364fc)

Reviewed again on 2026-11-06, at a3364fc. Since the second pass (2c9f198) the branch has a master merge (82417af), a fix to it (4589d60), and three test-timeout commits.

- **The merge (82417af).** Master brought local-first routing (Ticket 07), read roots, shell commands and more. The branch's own code diff against master (`git diff master...HEAD`) is still this ticket's work plus the items below. `session-manager.ts` keeps both sides: master's `planLocal` and this ticket's `localModel`/`runsLocalVariants` checks in `pickAgent` and `start`. The read-roots change in `widgets/claude-code/src/agent.ts` comes from master and applies to local and cloud Sessions alike, so the "Policy unchanged" box still holds.
- **The fix (4589d60) is right.** `planLocal` now puts the variant id on the Stage's model, not the server model id. `VariantService.localModel()` looks up by variant id, so with the server id a routed Session would not have been recognised as local: it would have gone to a cloud Agent with no `SessionStart.local`. The Widget still gets the server id through `SessionStart.local.serverModelId`, and usage is reported under the variant id, as the Ticket asks. The fake Agent now registers `runsLocalVariants: true`, which master's role-modes tests need now that `pickAgent` sends a local variant only to such an Agent.
- **The timeout commits** (0cbb610, 9f69531, 67e4dc3, a3364fc) only loosen waits in `story-flow.test.ts`, `demo-replay.test.ts` and the global `--test-timeout` (120 s to 300 s). They change no behaviour. A 300 s per-test cap does hide a test that slowly gets slower; it's acceptable while the machine is shared with the live Kiln, but worth tightening again later.
- Ran `npm ci`, then `node --test widgets/claude-code/test/local-session.test.ts packages/core/test/role-modes.test.ts`: 12 passed, 0 failed, 1 skipped (`KILN_REAL_LOCAL`). I did not run the full `npm test`. The implementing Digests report 486 of 500 passing, 0 failing, in one full run, and 1 failure in a later run under load.

New findings:

6. **Low: role-modes asserts the server model id, but the Session now runs on the variant id.** `packages/core/test/role-modes.test.ts:74` checks `session.model === variant.serverModelId`. It passes only because a new variant's id is the same as its server model id (`freshId(serverModelId)`). Once they differ (a second variant on the same server id after a removal, or an entry added by hand that collides), the test would fail while the code is right. It should check `variant.id`. It also leaves the 4589d60 fix untested: a test where the id and the server id differ would have caught the bug.
7. **Note, for ticket 07/09: the Budget a routed variant draws from.** `budgetOf` and the pool slot are looked up by the Session's model, which is now the variant id. Usage then goes to a Budget only if that Budget lists the variant id. That is what this ticket expects ("a local Budget listing the variant"), but nothing adds a new variant to the local Budget's list when it is added. If routing doesn't handle it, a routed Session may take no `LOCAL_POOL` slot. This is outside 03's scope; it is noted for the routing and GPU queue tickets.

Findings 1 and 2 are still open: no commit touches `local-session.test.ts`.

**Verdict still: accept.**

## Fourth pass: after the third master merge (51619ed)

Reviewed again on 2026-11-09, at 51619ed. The only change since the third pass (0f9e4d8) is this master merge.

- **The core side of the merge is right.** `git diff 51619ed^2 51619ed -- packages widgets` (the branch against master) is still this ticket's 12 files. `session-manager.ts` keeps master's chat and scratch routing and this ticket's `localModel`/`runsLocalVariants` checks in `pickAgent` and `start`, and `planLocal` still names the variant id.
- **Master changed the Widget in two ways.** Permissions moved to `@kiln/widget-sdk/tool-classifier`, and the hook now passes the shell's `cwd` and the Session's own folder to `requestFor`. Both apply to local and cloud Sessions alike. But master also added `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1'` to `claudeEnv()`, and a local Session doesn't use `claudeEnv()` (see finding 8).
- Ran `npm ci`, then `node --test widgets/claude-code/test/local-session.test.ts packages/core/test/role-modes.test.ts`: 12 passed, 0 failed, 1 skipped (`KILN_REAL_LOCAL`). `npm run typecheck` is clean. I did not run the full `npm test`.

New finding:

8. **Medium: a local Session loses master's shell working-folder setting.** `widgets/claude-code/src/agent.ts:306` gives a local Session `localClaudeEnv(process.env, …)`, not `claudeEnv()`. `localClaudeEnv()` (line 149) starts again from `process.env` and drops every `CLAUDE*` variable. So `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, which master added so that "a `cd` in one call never makes the next call's relative paths mean something other than what Kiln judges them by", reaches cloud Sessions only. A local model that runs `cd ..` keeps that folder for its next commands, which a cloud Session can't do. That breaks this Ticket's box "the Policy … stay exactly as for a cloud Session". Local models are also the ones the real runs saw wandering (`ls -la` first, whatever the Ticket says). Fix: set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1'` in `localClaudeEnv()`'s result, or better, build both from one list of Kiln-set variables so the next one isn't missed. Add an assertion to the local-session test that the logged environment has it. `local-session.test.ts` compares a local Session's options with a cloud Session's, but not its environment, which is why this got through.

Findings 1, 2 and 6 are still open: no commit since the third pass touches `local-session.test.ts` or `role-modes.test.ts` (it still asserts `variant.serverModelId`, now at line 82).

**Verdict: changes requested.** Finding 8 is a one-line fix plus a test assertion. Fix it before this ships. The rest of the work still meets the Ticket.

## Against the Ticket

| Requirement | Where | Met |
|---|---|---|
| `ANTHROPIC_BASE_URL` is the local server | `localClaudeEnv()` in `widgets/claude-code/src/agent.ts`; the fake SDK calls it, and the test checks every call against the fake server | yes |
| A fresh per-Session `CLAUDE_CONFIG_DIR` under the Widget's data folder | `freshConfigDir()` (mkdtemp under `local-claude-config/`); the test checks it is under the data folder and starts empty | yes |
| No Anthropic key, token or login in the environment | The regex `^(ANTHROPIC_\|CLAUDE\|KILN_)` drops them, then a dummy `ANTHROPIC_AUTH_TOKEN` is set; `settingSources: []` | yes (see finding 1) |
| The variant's server model id as the model | `optionsFor`: `--model` is `serverModelId` | yes |
| The Policy, Kiln MCP tools, attribution settings and trailer checks are unchanged | Only `model`, `env` and `maxBudgetUsd` change; the test compares the rest of the options with a cloud Session's, and the Agent contract runs on a local variant | yes |
| Usage goes to the local Budget at one turn per turn, with the variant id | `localUsage()` sets the variant id as the model and drops `costUsd`; the test checks this against a local Budget | yes |
| Add a shim if needed | None was needed (02's finding) | n/a |
| Gated real test through the Widget | Moved to ticket 14 | moved |

The core side is sound. `pickAgent` sends a variant only to an Agent with `runsLocalVariants`, and never falls back to another model of the same Budget. `start` checks this again. `localModel` returns 409 for a disabled or removed variant, or when the server has no URL. `plannedModel` and `plannedStart` catch that 409, so planning doesn't break when a variant is disabled.

## Findings

1. **Medium: the "no Anthropic credential" test doesn't plant one.** The test checks that the Session's environment has no `ANTHROPIC_*` or `CLAUDE*` variables other than the ones Kiln sets. But the test Kiln never puts an `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in the Widget's own environment. So the test passes whether or not the filter works, unless the machine running it happens to have one set. Fix: start the test Kiln with `env: { ANTHROPIC_API_KEY: 'sk-planted', CLAUDE_CODE_OAUTH_TOKEN: 'planted', ANTHROPIC_BASE_URL: 'https://planted.invalid' }` (and check it reaches the Widget), or unit-test the exported `localClaudeEnv()` with a parent environment that holds them.

2. **Low: nothing tests that the config folder is removed.** `play()`'s `finally` removes `local.configDir`, but no test checks that `local-claude-config/` is empty once the Session stops. If the Widget process dies, nothing cleans up its folders at the next start either. These folders hold transcripts and are not credentials, so the risk is a slow build-up of files. Suggest a test assertion after stop, and a sweep of `local-claude-config/` when the Widget starts.

3. **Low, unverified: the context alarm for a real local model.** The alarm uses `contextWindow` from Claude Code's `result.modelUsage`. The fake scenario sets it to 32,768. I have not checked that real Claude Code reports `CLAUDE_CODE_MAX_CONTEXT_TOKENS` there for a model it doesn't know. If it reports its 200K default instead, a 64K variant would overflow before the alarm goes off. Ticket 14's real run should record the reported `contextWindow`.

4. **Nit: the environment is set up in two places.** `widgets/claude-code/test/local-server.test.ts` (from 02) keeps its own `localClaudeEnv()`, which can drift from the Widget's. The 02 check could import the exported one.

5. **Nit: a restart starts with no transcript.** A local Session started again under the same id gets a new, empty config folder, so Claude Code can't pick up its old transcript. This matches what a cloud Session restart does today (the Kiln seed carries the context), so nothing needs to change now. It is noted here in case resume-from-transcript is ever added.

## Left open

- The real run through the Widget (ticket 14). The open notes in the Ticket (timeouts with `qwen-27b` at 64K) belong there.
