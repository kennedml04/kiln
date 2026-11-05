# 09: The Import scan and the Onboard Story

**What to build:** `POST /api/projects/scan` (Admin-only) reads a folder and never runs anything. It reports:
- the docs it found (`.scratch`, `docs/adr`, `GLOSSARY.md`, `AGENTS.md`, `CLAUDE.md`);
- test-command guesses from `package.json` scripts, `pyproject.toml` and a `Makefile`;
- suggested modules, from each module's `detect` globs;
- the git state.

Import shows all of this; the person confirms the test command and ticks modules, and both are written to `.kiln/settings.json` in one commit. A ticked **Bring it up to date** box creates a grill-stage **Onboard** Story whose description lists what's missing. It goes through the normal Workflow and is approved at a Gate. User stories 7 and 9 in `spec.md`.

**Blocked by:** 01, 03

**Status:** done

- [x] The scan finds docs, test commands and modules in sample folders, and runs no commands
- [x] Import writes the confirmed test command and modules in one commit
- [x] Bring it up to date creates an Onboard Story listing exactly what's missing
- [x] An import with nothing ticked registers the Project and writes nothing else

**Built:** the scan and Import's writes are `packages/core/src/work/import-scan.ts`; the types are
`packages/widget-sdk/src/project-scan.ts`; the Shell part is `packages/shell/src/work/ImportScan.tsx`.
Import's choices ride on `POST /api/projects` (`testCommand`, `modules`, `onboard`). The git state is
read from the `.git` folder, so the scan starts no process at all. A `detect` glob with no `/` matches
a file name at any depth; one with a `/` matches the repo-relative path. `.git`, `.kiln`,
`node_modules` and Python caches are not walked. Bring it up to date is offered only when a doc is
missing, and the Onboard Story lists only missing docs.
