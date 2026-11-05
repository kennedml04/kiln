# 06: The Software, Writing and CAD part modules

**What to build:** Three modules in the in-tree `modules/` folder.
- **Software:** today's Workflow with `tests_pass`. It detects `package.json`, `pyproject.toml`, `Cargo.toml` and `go.mod`.
- **Writing:** for docs or plans with no code. It replaces `tests_pass` with no check, keeps a review Gate, and detects only by preset.
- **CAD part:**
  - skills: cad-part, heatset-insert, visualize;
  - template: `cad/` plus an ignored `out/`;
  - Exit check: "every STL in the diff is watertight", a small script that ships with the module;
  - detects `*.scad`, `*.stl`, `*.3mf` and `*.step`.

Each module has its preset, and its skill folders are in generic form, with no personal paths. User stories 17, 18 and 21 in `spec.md`.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] All three validate, and their templates make the expected folders
- [ ] The watertight check passes a closed mesh and fails an open one (test meshes made in the test)
- [ ] A Writing Project's Ticket can ship with no test command
