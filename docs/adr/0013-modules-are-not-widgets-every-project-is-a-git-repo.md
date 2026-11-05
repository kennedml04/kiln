# Modules are declarative files, not Widgets, and every Project is a git repo

A Project pulls in **modules** for the kinds of work it holds (CAD part, 3D print, Electronics, Writing, Software). A module is a `kiln-module.json` file that lists skills, MCP servers, Exit checks, Stages, starter files and the Widgets it needs. It is data only. Kiln reads it and never runs anything from the module's folder. A module's Exit checks are commands that run in the Item's worktree, the same way `testCommand` runs for `tests_pass`. Its MCP servers run inside the Agent's Session, under that Session's Policy. A Project records its modules in `.kiln/settings.json`, and an id that no module source has is a Project error, shown the same way as a bad Workflow file.

Modules are separate from Widgets because Widgets are the only thing that runs code beside the core (0007). Widgets have Manifests, Grants and approval, and they are install-wide. A module needs none of that, because what it adds already runs somewhere that has a guard: the worktree under the Exit checker, or the Session under its Policy. Keeping modules out of the Widget host keeps permissions in one place and lets a Project carry its own modules in its repo. When a module needs something that runs code (the GitHub Widget, a slicer Widget), it names that Widget in `needs.widgets` and does not bundle it.

Every Project is a git repo, including hardware and writing Projects. Kiln's Workflow is built on worktrees, branches, checked Exits and merges at the Gate (0003), and the Tracker keeps Item records in the repo (0005). A Project without git would need a second Workflow engine. New Projects are created with `git init`. Large outputs (meshes, renders, gerbers) go in a `.gitignore`d `out/` folder or Git LFS.

## Considered options

- **Modules as Widgets**: one extension concept instead of two, but every kind of work would then need a process, a Manifest and an approval just to list some skills and a check command. A Project also could not carry its own. Rejected.
- **Project types**: one fixed type per Project. Rejected: real Projects mix kinds (a printed part with a PCB in it). A type survives only as a wizard preset that ticks modules.
- **Git-less Projects** for work with no code: rejected. They lose worktrees, checked Exits and the Tracker's records, which are the parts of Kiln that make the work reviewable.
