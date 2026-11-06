# Review: 07 Role modes, results and the variant picker

## Re-review (2026-11-05, HEAD 7b00517)

**Verdict: still send back.** Since the first review, the branch has gained only the merge of master (7b00517), and that merge brings in no Ticket 07 code. The last implementing Session left an empty Digest and no commit.

- **Must fix 1 is still open.** `planLocal` in `packages/core/src/flow/session-manager.ts` still sets `model: variant.serverModelId`. Ticket 03 is still not in this branch: `kiln/ticket/local-first/03` is not an ancestor of HEAD, and master has no `localModel` either. On 03, `variants.localModel(model)` matches `r.id === model`, and `pickAgent` sends a Session to an Agent with `runsLocalVariants` only when that lookup matches. So the fix is unchanged: merge or rebase onto 03, set `model: variant.id`, and update `role-modes.test.ts` so the local-only test checks for the local-variant Agent and the `SessionStart.local` block.
- Should fix 2–4 and the minor notes 5–10 below are also unaddressed.
- `variant-picker.test.ts` and `role-modes.test.ts` still pass after the merge (12 of 12). I did not run the full `npm test`.
- Ordering note: master's "merge local-first/10" and "/11" commits bring in no routing code (master has no `picker.ts`), and 11's tracker note says it is blocked until 07, 08 and 03 have code. So 07 plus 03 is still the first thing that has to land.

The first review follows, unchanged.

---

Reviewed commit 0486642 against `.scratch/local-first/issues/07-role-modes-and-the-variant-picker.md` and the spec.
`variant-picker.test.ts` and `role-modes.test.ts` pass in this worktree (12 of 12). I did not rerun the full `npm test`; the implementer reported 468 passing.

**Verdict: send back before merging.** The picker, the role modes and the validator match the Ticket. The way a picked variant is handed to the Agent does not match Ticket 03, which this Ticket is blocked by. Once the two are merged, a "local" Session would run on the cloud Agent.

## Must fix

1. **The Session's model is the variant's server model id, but Ticket 03 needs the variant id.**
   - **Where:** `packages/core/src/flow/session-manager.ts`, `planLocal`, which sets `stage: { ...stage, model: variant.serverModelId }`.
   - **Why it matters:** this branch was cut from a base without Ticket 03 (`local-first-03` is not an ancestor of HEAD). On `local-first-03`, a Session counts as local only when its `model` is a variant **id** (`variants.localModel(model)` matches on `r.id`). In that case `pickAgent` picks an Agent with `runsLocalVariants`, and the start command carries `SessionStart.local` (server URL and server model id).
   - **What breaks when merged:** `localModel(serverModelId)` returns undefined. The Session goes to whichever Agent is ready, with the local server's model name as a cloud model, an Anthropic login and no `local` block. A local-first Ticket would fail on cloud, or run there. A **local-only** Project would start a Session against the cloud Agent, which is exactly what acceptance item 4 rules out.
   - **Fix:** rebase onto Ticket 03 and set `model: variant.id`, so 03's `localModel` path does the routing and usage goes against the local Budget. Then update the assertion in `role-modes.test.ts` (`session.model === variant.serverModelId`), and make the local-only test check that the Session reached the local-variant Agent with a `local` block, not just that its model isn't the cloud one.

## Should fix

2. **Several failed local attempts record no result.** `recordLocalResult` records a fail only for `error`, or for `stopped` through `giveUp`. These end with no result at all:
   - an Agent finish of `interrupted` that Kiln didn't ask for;
   - `renew` (stopped with a reason);
   - a runaway or Budget hold that is then stopped.

   The stall and turn-cap cases are the failures the spec most wants counted (story decision 3: "a turn cap or a time cap"). Ticket 08 owns escalation, but recording is this Ticket's job. At the least, add `renew`'s reason as a failure and list the rest as open in the Ticket's As built.

3. **Ticket size only learns from local attempts.** `ticketSize` reads only this Item's `variant_results`. Earlier cloud Sessions of the same Item (whose diffs exist in `sessions`/worktrees) never inform size. The Ticket says "from the Item's earlier diff lines and files touched". Either compute the diff for every Session end, or say in As built that only local attempts count.

4. **The estimate is read from a `**Estimate:**` line that no tracker template writes.** Nothing in `docs/agents/issue-tracker.md` or the ticket-writer prompt produces it, so in practice size is always the diff or medium. Either add the field to the ticket-writer's output, or document the line format in the issue-tracker doc.

## Minor / notes

5. **Pins aren't validated.** `PUT /api/local-routing` accepts any `variantId` and any role name. A pin on a disabled, removed or mistyped variant is silently ignored by the picker, with no Thread note. Suggest a 400 for unknown variant ids, or a Thread note like "pinned variant X is not enabled; picking by the rules".
6. **Tokens per second is output tokens over the whole wall time,** tool runs and test runs included. It isn't the model's generation speed, so label it as such on the scoreboard (Ticket 12), or measure per turn once 03's usage events carry timings.
7. **The role-pin harness test has only one variant,** so the picker would have chosen it anyway; only the reason text shows the pin worked. The unit test covers the real override, so this is fine, but a second variant would make the harness test meaningful.
8. **The explore seed is `itemId:resultCount`.** That is deterministic, which is good, but the same Item restarted with no new result always makes the same choice. Fine for now; just noting it.
9. **The silent cloud fallback when no local server is configured** (`!inUse() && !variants().length`) departs from "runs on cloud and says so". It is a sensible choice and the As built records it.
10. **A local-only start refused with 409 drops the Item from Up next,** via `scheduler.start_failed`, the same as other non-"not ready" errors. Ticket 11 (the GPU queue) will need local-only Items to wait instead.

## Checked and fine

- Picker: new variants first (fewest results, list order on ties), best rate at the size (falling back to all sizes), 1 in 5 exploring with a seeded source, the per-role, per-size 3-in-a-row cut-off, a Ticket pin over a role pin, and a reason string for each case. All are covered by the unit tests.
- Role mode defaults (`defaultRoleMode`), the validator accepting the three modes and naming them when it rejects one, and the `STAGE_FIELDS` update.
- Size thresholds are written in `routing.ts`; the largest earlier attempt wins.
- The install-wide switch is Admin-only (`access.ts`), the `variant_results` and `variant_pins` migrations are appended, and the results are readable at `GET /api/variant-results`.
- The `pr-mode` test change is correct: a local-only Project can no longer run its cloud Sessions up to the Gate.
