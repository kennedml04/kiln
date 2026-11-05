# 03: Fake Agent scripts per Item

**What to build:** The fake Agent can run a different script for each Item that shares a role. A key in a role-keyed `FakeAgentScripts` may be `"<role>@<text>"`. It is used when `<text>` appears in the Session's prompt, which names the Item's title. Otherwise the plain `"<role>"` key applies, then `"*"`. Only `packages/testing/src/fake-agent/script.ts` and `main.ts` change, not the Agent interface. A test pins the prompt wording that names the Item (`for the <kind> "<title>"` in `itemPrompt`, `packages/core/src/flow/session-manager.ts`), so a change to it fails loudly instead of quietly breaking the demo's Replay. See "The replay scripts" in `spec.md`.

**Blocked by:** None

**Status:** resolved

- [x] `"implementer@Add slugify"` is used for a Session whose prompt names that title, and `"implementer"` for any other implementer Session
- [x] When two `@` keys both match, the longer `<text>` wins
- [x] The fallback order is `role@text`, then `role`, then `*`, then finish at once; the doc comment on `FakeAgentScripts` says so
- [x] A core test pins the prompt's Item-title wording
