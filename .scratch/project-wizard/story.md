---
title: Project wizard (New and Import) and Project modules
epic: projects-and-onboarding
stage: tickets
blocked-by: []
---
Starting a Project in Kiln today means typing a folder path into a form, and every Project is treated as a software repo. This Story adds a **+ Project** wizard on the board with two paths, **New** and **Import**, and **modules**: small files a Project switches on to pull in the skills, tools, Exit checks, Stages and starter folders its kind of work needs (3D printing, CAD parts, KiCad, writing, software). A Project can mix modules and add more later, and a Project can have no software at all. It replaces the folder-picker Story (`.scratch/project-folder-picker/story.md`). Grilled 2026-11-05; the decisions are below. The spec is `spec.md`.

## Decisions (grill, 2026-11-05)

1. **Modules, not types.** A Project is a folder plus the modules it pulls in. A "type" is only a preset that ticks modules in the wizard. Modules can be added to a Project later.
2. **A module is not a Widget.** A module is a small declarative file: the skills, tools (MCP servers), Workflow Stages, Exit checks and starter folders it brings, and the Widgets it needs. It never runs code itself. Widgets stay the only thing that runs code, so permissions stay in one place.
3. **Every Project is a git repo**, hardware and writing ones too. Kiln makes the repo when it creates a Project. Large outputs (meshes, renders, gerbers) go in a `.gitignore`d `out/` folder or Git LFS.
4. **Modules can add skills, tools, Exit checks and Stages.** For example "KiCad DRC passes" or "the slice reports no problems" as Exit checks beside or instead of `tests_pass`, and "Print it" or "Order parts" as Stages that are the person's move.
5. **Modules come from module repos**, the same plumbing as the planned Widget and Skill repos. Kiln ships a default module repo; the person can add their own. A Project can also carry its own modules under `.kiln/modules/`.
6. **One Projects folder**, set in Settings. New Projects are made in `<Projects folder>\<name>`. Imported Projects stay where they are and are never moved.
7. **Import is a free scan, then an optional Onboard Story.** The scan uses no AI: it finds existing docs (`.scratch`, `docs/adr`, `GLOSSARY.md`, `AGENTS.md` / `CLAUDE.md`), the test command, and suggests modules from the files it sees (`*.kicad_pro` → Electronics; `*.scad`, `*.stl`, `*.3mf` → CAD part and 3D print; `package.json`, `pyproject.toml` → Software). The person ticks modules. A "Bring it up to date" box creates an **Onboard** Story that goes through the normal Workflow, writes what's missing, and is approved at a Gate.
8. **New makes the folder from module templates and starts a grill.** Name, a one-line description and modules; Kiln makes the folder, runs `git init`, commits a README, `.kiln/settings.json` with the modules, a `.gitignore` and each module's starter folders, registers the Project, and opens a grill-stage Story "What we're building" seeded with the description.
9. **A Project's modules are recorded in the repo**: `"modules": [...]` in `.kiln/settings.json`. Project settings → Modules → Add commits that change plus the module's starter folders if they're missing. New Sessions then get the module's skills and tools; new Items get its Stages and Exit checks.
10. **The first modules:** Software (today's Workflow with `tests_pass`), CAD part (cad-part, heatset-insert and visualize skills; "the STL is watertight"), 3D print (the Bambu Studio MCP; "the slice reports no problems"; a "Print it" Stage), Electronics (KiCad and bom-shopping; "DRC passes"; an "Order parts" Stage), and Writing (docs or plans with no code; no test check, a review Gate only). A MakerWorld listing Stage can come later inside 3D print.
11. **One wizard, two doors.** The board's Register Project form becomes **+ Project** (New / Import), with the folder browser from the folder-picker Story. The setup wizard's last step ends with the same choice (New, Import, or the old board's list). The folder-picker Story folds into this one.
12. **GitHub repo: an optional box, off by default**, offered only when the GitHub Widget is installed. Ticked, it creates a private repo, adds the remote and pushes the first commit.
