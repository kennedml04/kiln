# 03: The module file, `modules` in settings, and the in-tree module repo

**What to build:**
- **`kiln-module.json` with a validator**, in the style of `packages/widget-sdk/src/manifest.ts`. Its fields: `id`, `name`, `description`, `presets`, `needs.widgets`, `skills`, `mcpServers`, `exitChecks`, `stages`, `template` and `detect`, as listed under "The module file" in `spec.md`.
- **A module source** that reads the in-tree default module repo (`modules/` at this repo's root, empty for now) and a Project's own `.kiln/modules/<id>/`. When two modules have the same id, the earlier source wins.
- **`modules: string[]`** in `.kiln/settings.json`, validated in `project-files.ts`. An unknown id becomes a Project error on the board.
- A Project with no `modules` field behaves exactly as today.
- **`GLOSSARY.md`** gets a "Module" entry: not a Widget, runs no code.
- **A new ADR**: modules are separate from Widgets, and every Project is a git repo.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Valid and invalid module files are accepted and rejected with clear messages (unit tests)
- [ ] A Project's `.kiln/modules/` module and an in-tree module both resolve, and the earlier source wins a clash
- [ ] An unknown module id in settings shows as a Project error; no `modules` field changes nothing
- [ ] The glossary entry and the ADR exist
