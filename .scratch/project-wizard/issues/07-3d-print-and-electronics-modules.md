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

**Status:** ready-for-agent

- [ ] Both validate, and their templates and Stages appear in a Project's effective Workflow
- [ ] With the CLIs faked, the slice check and the DRC check pass and fail as their output says
- [ ] "Print it" and "Order parts" show as the person's move on the board
- [ ] Opt-in real tests exist and are skipped by default
