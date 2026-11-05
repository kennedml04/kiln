# Spec: Project wizard (New and Import) and Project modules

Status: needs-triage

Sources: `.scratch/project-wizard/story.md` (the grill decisions of 2026-11-05), `.scratch/project-folder-picker/story.md` (folded in), `.scratch/skill-and-widget-repos/` (Skill and Widget repos, unbuilt), and the code as of branch `demo-project` (e897f71).

## Problem Statement

- Registering a Project means typing its full path into the board's Register Project form (`packages/shell/src/work/HomeBoard.tsx`). A typo surfaces late. A folder that isn't a git repo registers fine and fails at its first worktree.
- There is no way to start a new Project from Kiln. The demo (`packages/core/src/demo/demo.ts`) is the only code that makes a repo from a template and registers it.
- Every Project gets the same software Workflow. A Project for a 3D-printed part, a PCB or a written plan has no `testCommand`, so `tests_pass` can never pass. Its real steps (slice and print, order parts) aren't on the board at all.
- Kiln has no notion of what kind of work a Project holds. Widgets are install-wide (`<dataDir>/widgets/<id>`), and Kiln does not load skills (the Claude Code Widget runs with `settingSources: []`). So a Session for a CAD Project gets none of the CAD skills or tools.
- Importing an existing repo tells Kiln nothing about its docs, test command or conventions. Bringing an old repo up to the Workflow's conventions is manual.

## Solution

A **+ Project** wizard with **New** and **Import**, reached from the board and from the setup wizard's last step. Projects pull in **modules**. A module is a small declarative file that lists the skills, tools, Exit checks, Stages and starter folders a kind of work needs, and the Widgets it requires. A Project records its modules in `.kiln/settings.json`, can mix them, and can add more later. Every Project is a git repo. New Projects are made in a Projects folder set in Settings, from the modules' templates, and start with a grill. Imported Projects get a free scan with no AI, which suggests modules, and an optional Onboard Story that brings their docs up to date.

## User Stories

### Starting a Project

1. As the owner, the board's **+ Project** button offers New and Import. The setup wizard's last step offers the same two, plus the old board's list.
2. As the owner, New asks for a name, a one-line description and modules. Presets ("Software", "Printed part", "PCB", "Writing") tick a set of modules for me, and I can change the ticks.
3. As the owner, New makes `<Projects folder>\<name>`, runs `git init -b main`, and commits a README, `.kiln/settings.json` (with the modules and any `testCommand`), a `.gitignore` and each module's starter folders. It then registers the Project.
4. As the owner, a new Project opens with a grill-stage Story "What we're building", seeded with my description, so my first step is a grill.
5. As the owner, when the GitHub Widget is installed, New offers "Also create a private GitHub repo", off by default. Ticked, it creates the repo, adds the remote and pushes the first commit.
6. As the owner, Import lets me click through folders with a browser served by the core, which works the same from my phone. I don't have to type a path.
7. As the owner, Import scans the folder with no AI. It shows the docs it found (`.scratch`, `docs/adr`, `GLOSSARY.md`, `AGENTS.md` / `CLAUDE.md`), the test command it found, and the modules it suggests from the files.
8. As the owner, an imported Project stays where it is. Kiln never moves it.
9. As the owner, ticking "Bring it up to date" on Import creates an Onboard Story. It runs through the normal Workflow, writes whatever docs are missing, and I approve it at a Gate.
10. As the owner, importing a folder that isn't a git repo offers "Initialise as a git repo" right there, with a first commit, instead of failing later.

### Modules

11. As the owner, Project settings → Modules lists the Project's modules, and I can add one later. Adding one commits the `.kiln/settings.json` change, plus the module's starter folders if they're missing.
12. As the owner, a Session in a Project gets the skills and tools of the Project's modules, and nothing from modules the Project doesn't have.
13. As the owner, a module's Exit checks (for example "DRC passes") replace or sit beside `tests_pass` on the Stages the module says.
14. As the owner, a module's Stages appear in the Project's Workflow. For example, 3D print adds "Print it" after Review, a Stage that is my move.
15. As the owner, a module that needs a Widget the install doesn't have says so when I pick it, and links to installing that Widget.
16. As the owner, I can add a module repo in Settings, and a Project can carry its own modules under `.kiln/modules/`.

### The first modules

17. As the owner, **Software** gives today's Workflow, with `tests_pass` on the Project's `testCommand`.
18. As the owner, **CAD part** gives Sessions the cad-part, heatset-insert and visualize skills, `cad/` and an ignored `out/` folder, and the Exit check "every STL in the diff is watertight".
19. As the owner, **3D print** gives Sessions the Bambu Studio MCP, the Exit check "the slice reports no problems", and a "Print it" Stage that is my move.
20. As the owner, **Electronics** gives Sessions the KiCad tools and the bom-shopping skill, `pcb/`, the Exit check "DRC passes", and an "Order parts" Stage.
21. As the owner, **Writing** gives a Workflow with no test check and a review Gate only, for docs and plans with no code.

## Implementation Decisions

### The module file

- A module is a JSON file, `kiln-module.json`, validated like `kiln-widget.json`. It sits in a module repo folder or under a Project's `.kiln/modules/<id>/`. Its fields:
  - `id`, `name` and `description`;
  - `presets`: the wizard presets it belongs to;
  - `needs.widgets`: the ids of the Widgets it needs;
  - `skills`: skill names. They resolve through the Skill repos when those land; until then, through skill folders inside the module;
  - `mcpServers`: Claude Code MCP server entries;
  - `exitChecks`: named command checks, `{ id, name, command, stages, replaces? }`;
  - `stages`: Stages to add to a kind, `{ kind, after, stage }`, using the existing `Stage` shape;
  - `template`: a folder of starter files, with `out/`-style ignore lines;
  - `detect`: file globs the Import scan uses to suggest the module.
- **Modules never run code inside Kiln.** Their Exit checks are commands that run in the Item's worktree, the same way `testCommand` runs for `tests_pass`. Their MCP servers run inside the Agent's Session, under the Session's Policy.
- **Module repos** use the git fetch path from `.scratch/skill-and-widget-repos/issues/01` (safe git fetches). Kiln ships a default module repo, in-tree under `modules/` in this repo, holding the five first modules. Settings lists the module repos in order, and an earlier repo wins when two have the same id.

### A Project's modules and its Workflow

- `.kiln/settings.json` gains `modules: string[]`. `project-files.ts` validates the field, and an unknown module id is a Project error shown on the board, the same way a bad Workflow file is shown.
- **The effective Workflow** is the Project's Workflow (the default, or `.kiln/workflow.json`), with each module's Stages inserted in module order and its Exit checks applied. It is computed when the Project's files load, and the existing validator checks it. A module that makes an invalid Workflow is a Project error, and the Project keeps its last valid Workflow.
- **Exit checks** gain a command kind: `module:<module>/<check>`. The exit checker runs the command in the worktree, and a non-zero exit fails the check, with its output in the Thread.
- **The Claude Code Agent** gets the Project's module skills and MCP servers for each Session. Skills are copied into the Session's config folder, never into the repo. Only skill folders load, never settings or hooks, as `.scratch/skill-and-widget-repos/issues/05` already decides for Project skills.
- **A Project with no `modules` field behaves exactly as today.** So does the default when the field is missing: Software only, which is today's Workflow.

### The wizard

- **Core API:**
  - an Admin-only folder listing, `GET /api/fs/folders?path=`;
  - `POST /api/projects/scan` (folder → found docs, test command, suggested modules, git state);
  - `POST /api/projects/new` (name, description, modules, githubRepo?).
  
  Register stays `POST /api/projects`, and it gains a git check. All three new routes are Admin-only.
- **New:**
  1. Make the folder.
  2. Copy each module's template.
  3. Write `.kiln/settings.json` and a README.
  4. Run `git init -b main` and make one commit as the install's git identity. That is the same identity Kiln commits Tracker records as.
  5. Register the Project.
  6. Create the "What we're building" Story through the Tracker.
  7. If the box was ticked, create the GitHub repo and push, through the GitHub Widget.

  A step that fails names itself and leaves the folder in place, unregistered, so a retry can continue.
- **Import:** the scan only reads files, never runs commands. Its test command guesses come from `package.json` scripts, `pyproject.toml` and `Makefile`, and the person confirms them. The Onboard Story is a normal grill-stage Story whose description lists what is missing. Its Sessions use the existing Workflow.
- **The Projects folder** is a core Setting with no default. The wizard asks for it the first time New is used.
- **Folder browser** (folded in from the folder-picker Story), with defaults to confirm at the spec Gate:
  - Browsing is limited to roots the Admin chooses. The Projects folder is always one of them.
  - Hidden and system folders are skipped, and junctions are not followed.
  - Each folder shows whether it is a git repo, whether it is already registered, and whether it has a `.scratch` tracker.
  - A typed-path box stays alongside the tree.
  - A repo that isn't on its default branch or has no commits is refused, with the fix spelled out. Kiln never switches branches for you.
  - The Knowledge store paths in Settings and the setup wizard reuse the same browser.
  - On a dev instance, the browser is offered only for roots inside the dev data folder.

### Order and dependencies

- **Module skills depend on Skill support.** `.scratch/skill-and-widget-repos/issues/03`–`05` aren't built yet. Until they are, a module's skills are loaded from skill folders inside the module itself, using the same loading code that issue 05 will reuse.
- **Module repos depend on safe git fetches** (`.scratch/skill-and-widget-repos/issues/01`). The in-tree default module repo needs no fetch, so the first modules don't wait for it.
- Suggested ticket order:
  1. The folder browser, the git check, and New with no modules.
  2. The module file and its validator, plus `modules` in settings.
  3. The effective Workflow, with module Stages and command Exit checks.
  4. Module skills and MCP servers reaching Sessions.
  5. The five first modules.
  6. The Import scan, then the Onboard Story.
  7. The wizard in the setup wizard.
  8. The GitHub box.
  9. Module repos.

## Testing Decisions

- The folder listing, the scan and New get tests against temporary folders, including a non-repo, a repo with no commits, and a repo off its default branch.
- The effective Workflow is tested as a pure function: a Workflow plus modules gives the expected Stages and checks. An invalid result is reported as a Project error.
- Command Exit checks are tested with small scripts that pass and fail, in a temp worktree.
- The Claude Code Agent's module skills and MCP servers are tested through the fake SDK's logged options.
- The five first modules each get a test that New creates their template, and that their checks run. KiCad and the Bambu Studio CLI are faked in tests; the real tools run only in opt-in real tests.
- Shell tests drive the wizard: New, Import with the scan, and adding a module later.

## Out of Scope

- Moving or renaming an imported Project's folder.
- Project types as a separate concept from modules.
- Git-less Projects.
- A module marketplace, module versions, or module updates beyond re-fetching a repo.
- The MakerWorld listing Stage, which comes later inside 3D print.
- Linked Projects (`.scratch/linked-projects`), which stays its own Story.

## Further Notes

- "Module" is a new glossary term, and `GLOSSARY.md` needs it: a module is not a Widget and runs no code.
- An ADR should record why modules are separate from Widgets, and why every Project is a git repo.
