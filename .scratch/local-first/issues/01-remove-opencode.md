# 01: Remove the OpenCode Agent

**What to build:** Delete `widgets/opencode/` and every live reference to it: `package-lock.json` (through `npm install`), the README's Widget list, `GLOSSARY.md`, `packages/core/src/setup/setup.ts`, `packages/shell/test/setup-wizard.test.ts` and `packages/testing/src/harness.ts`. Write a short ADR amending ADRs 0004 and 0009: local models run through the Claude Code Agent. Set `.scratch/opencode-real-run/issues/01` to wontfix, with a pointer to `.scratch/local-first/spec.md`. Older tracker files stay as they are. See "Removing OpenCode" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `widgets/opencode/` is gone, and nothing outside `.scratch/` and `docs/adr/` names OpenCode
- [ ] The setup wizard offers no OpenCode Agent, and its test says so
- [ ] A new ADR records that local models run through the Claude Code Agent; ADRs 0004 and 0009 are unchanged
- [ ] `.scratch/opencode-real-run/issues/01` is wontfix with a pointer to this spec
- [ ] `npm test` passes
