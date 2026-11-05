---
title: Pick or create a Project's folder from the board
epic: projects-and-onboarding
stage: grill
---
Registering a Project today means typing its folder's full path, and a mistake surfaces late. A path that doesn't exist is refused ("No folder at …"), but a folder that isn't a git repo registers fine and fails at its first worktree. Three changes. First, a folder browser served by the core: the core lists folders through an Admin-only API, and the Register Project form opens them as a tree you click through, instead of only a text box. A browser's own file picker can't give a real folder path, so the core does the listing, and it works the same from the phone over Tailscale. Second, **New Project** in the same browser: make a new folder, run `git init -b main` with a first commit, and register it, ready for its first Story. Third, registration checks the folder is a git repo (the top of its work tree, with a default branch and at least one commit), and says how to fix it if not, instead of failing later. The first real Story on the live board once the demo is done.

## Questions for the grill

- Where the browser may go: the whole disk, or only under roots the Admin chooses (for example `C:\Users\<you>\projects`). Hidden and system folders, junctions and other drives.
- What the tree shows on each folder: whether it is a git repo, already registered, or has a `.scratch` tracker. Whether a remembered list of recent folders or a typed-path box stays alongside it.
- New Project: what the first commit holds (empty, a README, `.kiln/settings.json` with a testCommand, `.scratch/`), whether it can also create a GitHub remote, and which git identity it commits as.
- A folder that's not a repo: offer "Initialise as a git repo" right there, or only refuse with the fix.
- A repo whose checkout isn't on its default branch, or has no commits: refuse, warn, or fix.
- Who may use it: Admins only, and whether it is offered on a dev instance (where real Projects are added only by hand).
- Whether the Settings and wizard paths that ask for a folder (the Knowledge store) use the same browser.
