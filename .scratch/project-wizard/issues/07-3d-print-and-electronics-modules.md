# 07: The 3D print and Electronics modules

**What to build:** Two modules in the in-tree `modules/` folder.
- **3D print:**
  - the Bambu Studio MCP server entry;
  - Exit check: "the slice reports no problems", a command that slices with the Bambu Studio CLI and fails when its problems list isn't empty;
  - a "Print it" Stage after Review, with no role, so it's the person's move;
  - detects `*.3mf` and `*.gcode`.
- **Electronics:**
  - the bom-shopping skill and the KiCad CLI;
  - template: `pcb/` plus an ignored `out/`;
  - Exit check: "DRC passes", via `kicad-cli pcb drc`, which fails on errors;
  - an "Order parts" Stage after Review, with no role;
  - detects `*.kicad_pro`.

The tools' paths are Settings or found on `PATH`, never hard-coded. In tests, both CLIs are faked; the real tools run only in opt-in real tests. User stories 19 and 20 in `spec.md`.

**Blocked by:** 04, 05

**Status:** done

- [x] Both validate, and their templates and Stages appear in a Project's effective Workflow
- [x] With the CLIs faked, the slice check and the DRC check pass and fail as their output says
- [x] "Print it" and "Order parts" show as the person's move on the board
- [x] Opt-in real tests exist and are skipped by default

**Built:**
- `modules/3d-print` and `modules/electronics`. Each check is a plain Node script in the module's `checks/`.
- Module commands and stdio MCP entries may use `{moduleDir}` (the module's folder, as in ticket 06) and `{tool:<name>}`. `{tool:<name>}` is the path in the new `toolPaths` Setting (Settings > Tool paths, or `PUT /api/setup`), else the bare name, found on PATH.
- The board marks an Item "Your move" when its Stage has no role, isn't a roll-up and isn't the kind's last Stage.
- The real-tool tests run only with `KILN_REAL_CAD_TOOLS=1`.
- The module checks sit beside `tests_pass`; they don't replace it. With no `.3mf` or no `.kicad_pcb` in the worktree, the check passes.
