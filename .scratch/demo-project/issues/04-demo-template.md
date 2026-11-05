# 04: The demo template

**What to build:** `packages/demo/template/`, the tiny JavaScript project the demo copies. It holds:
- `package.json` with no dependencies.
- `src/index.js` with one starter function, and its test in `test/index.test.js`.
- `README.md` describing the toy project.
- `.kiln/settings.json` with `testCommand: "node --test"` and local merge.
- `.kiln/policy.json`, starting from `%TEMP%\kiln-scratch-repo`'s.
- `.scratch/slugify/story.md` at `stage: grill`. It says what `slugify` must do and leaves two open questions: accented letters, and whether an empty result is an error.

The folder is copied verbatim and is not a workspace package. See "The template" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `node --test` passes in a fresh copy of the template
- [ ] The monorepo's install and tests ignore the template's `package.json`
- [ ] The template is registered as a Project by a test core, and its markdown Tracker reads exactly one Story, "Add `slugify(title)`", at Grill
- [ ] The two open questions are in the Story body, so a real griller raises them in Live
