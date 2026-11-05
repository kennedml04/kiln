# 08: Modules in New, and adding a module later

**What to build:** New gets presets ("Software", "Printed part", "PCB", "Writing"), which tick modules, and a module checklist. The chosen modules' templates are copied into the first commit, and the modules are listed in `.kiln/settings.json`. Project settings → **Modules** lists the Project's modules, and **Add** commits the `modules` change plus the module's template folders if they're missing (never overwriting files). New Sessions and new Items then pick the module up. A module that needs an uninstalled Widget says so in both places and links to installing it. User stories 2, 11 and 15 in `spec.md`.

**Blocked by:** 02, 06

**Status:** ready-for-agent

- [ ] New with a preset makes the modules' folders and lists them in settings
- [ ] Adding a module later commits only the settings change and missing template files
- [ ] A module needing a missing Widget is flagged before it's added
- [ ] Shell tests drive both the New flow and the Add flow
