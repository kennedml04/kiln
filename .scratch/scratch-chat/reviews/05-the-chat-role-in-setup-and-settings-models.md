# Review: 05 The chat role in setup and Settings → Models

Branch `kiln/ticket/scratch-chat/05`, commits 0d88956 and 0a7dc5d.

**Verdict: changes requested.** Setup, `checkRoles` and the `suggestRoles` rule are done and work. The ticket's last clause, the "Choose a model for the chat role in Settings → Models" message, is missing, and there are two smaller behaviour problems.

Checked: `node --test packages/core/test/setup.test.ts` (20/20 pass) and `npm run typecheck` (clean). I did not run the full `npm test` or the Playwright suites.

## What the ticket asks, and where it stands

| Ask | Status |
|---|---|
| `chat` in `defaultRoles` | Done (`packages/core/src/setup/setup.ts:113`, labelled "Scratch chat") |
| `checkRoles` accepts `chat` | Done: it uses `defaultRoles()`, so `chat` is known; covered by the new setup test |
| `suggestRoles` rule: local, else Haiku-tier, else default mid | Done (`packages/shell/src/role-defaults.ts:36`, `pickChat`). See finding 2 about the fallback it picks. |
| Editable in setup's Models step | Done without new code: the wizard renders `setup.roles`, so `chat` appears with a suggestion |
| Editable in Settings → Models | Done: new `ChatRole` block in `ModelsPage.tsx`, Admin only through the `/settings/models` route |
| Opening a chat with no chat role → "Choose a model for the chat role in Settings → Models" | **Not done.** See finding 1. |

## Findings

### 1. The missing-chat-role message is not implemented (blocking)

Nothing in the branch produces "Choose a model for the chat role in Settings → Models". This branch's base doesn't have the chat routes or session code from ticket 01. They are on `kiln/ticket/scratch-chat/01`…`/10` (commit 59edbe9 adds `roleModel: () => setup.settings().roles?.chat` and `scratchChatStage(chats?.roleModel())`). So there is nowhere here to check it. As things stand, once ticket 01 lands, a chat on an install set up before this Story gets a Stage with no model. It will fail in some generic way, or run on the Agent's default model, with no message pointing to Settings.

Fix: rebase onto ticket 01's work, or coordinate with it. Then make `POST /api/chats` and `POST /api/chats/:id/messages` refuse with 409 and exactly "Choose a model for the chat role in Settings → Models" when `settings.roles.chat?.model` is empty. Add the test the spec asks for: with a completed setup and no `chat` role set, opening a chat returns that message.

### 2. A local chat model gets the strongest metered model as its fallback (should fix)

`suggestRoles` runs the shared `fallback()` on the `chat` pick. It returns the strongest model in another Budget. When `pickChat` picks a local model, the suggested fallback is therefore the strongest metered model, usually Opus. For a role whose point is to be cheap, any local-server hiccup sends quick questions to the most expensive model, both in the wizard and in Settings → Models. Suggest a chat-specific fallback: the lightest model in another Budget (Haiku-tier first), or none.

### 3. Existing installs now need a chat model before the Live demo (should fix, or decide)

`missingRoles()` now includes `chat`. Besides `complete()`, the demo's Live mode uses it (`packages/core/src/demo/demo.ts:141`). An install that finished setup before this Story will be refused Live with "choose a model for the chat role first", even though the demo never uses chat. The spec says such an install *has no chat role* and finds out when it opens a chat. It doesn't say other features should start refusing. Either have the Live check ignore `chat` (for example, a `missingWorkflowRoles()` limited to the Workflow's roles), or record this as intended.

The setup gate itself (`complete()` refusing until `chat` has a model) is in line with "setup's Models step lists a `chat` role". It also means `chooseEveryRole` and the demo tests had to add `chat`, which 0a7dc5d does.

### 4. Tests the spec asks for are missing (should fix)

- **Setup suggestion:** "the Models step offers `chat`, suggesting the local model when a fake local server is found and Haiku otherwise". The new core test only checks that `chat` is listed and that a model saves. `suggestRoles` is Shell code, so this needs either a Playwright test in the wizard or a unit test of `suggestRoles` (local Budget present → local model; only Opus/Sonnet/Haiku → Haiku; no Haiku → mid).
- **Settings → Models:** no browser test of the new `ChatRole` block (suggestion shown on an install with no `chat`, Save persists it). `packages/shell/test/models-page.test.ts` is the natural home.
- **The missing-role message:** see finding 1.

### 5. Small things (nits)

- `ChatRole` keys `<option>` by model name. A model listed in two Budgets gives duplicate React keys. The wizard has the same pattern, so this is consistent but worth fixing in both places (key by `budget + model`).
- `ChatRole` shows "Suggested: …" but saves nothing until the Admin presses Save. That fits "Settings shows the suggestion", but the hint could say "not saved yet" so an Admin doesn't leave thinking it's set.
- `checkRoles`' error for an unknown role still says "The default Workflow has no … role". It's accurate for every role except `chat`, so it's fine for now.
- The `ModelsPage` import list puts `BudgetInfo, RoleModel, SetupState` before the alphabetical rest. Cosmetic.

## What is good

- `defaultRoles` guards with `if (!roles.has('chat'))`, so a Workflow that already has a `chat` role isn't duplicated.
- `checkRoles` merges into `settings.roles`, so `ChatRole`'s `PUT /api/setup { roles: { chat } }` doesn't wipe the other roles. I checked this.
- `decorate()` only maps Workflow Stage roles, so `chat` doesn't leak into any Workflow.
- `ChatRole` reuses `suggestRoles`, so setup and Settings suggest the same model.
