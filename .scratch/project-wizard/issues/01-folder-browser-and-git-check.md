# 01: The folder browser, the git check, and + Project → Import

**What to build:** An Admin-only core folder listing (`GET /api/fs/folders?path=`) restricted to browse roots set in Settings. The Projects folder is always a root once it is set. The listing skips hidden and system folders and doesn't follow junctions. Each folder shows whether it is a git repo, already registered, or has a `.scratch` tracker. The board's Register Project form becomes **+ Project** with **Import**: a clickable tree, plus a typed-path box. Registration checks for git:
- The folder must be the top of a work tree, on its default branch, with at least one commit.
- A repo that fails is refused, with the fix spelled out. Kiln never switches branches.
- A folder that isn't a repo offers **Initialise as a git repo**, with a first commit, then registers.

The Knowledge store folder fields in Settings and the setup wizard use the same browser. On a dev instance, the roots are limited to the dev data folder. User stories 6, 8 and 10 in `spec.md`; "The wizard" and the folder-browser defaults in Implementation Decisions.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] The folder listing is Admin-only, stays inside the roots, skips hidden and system folders, and doesn't follow junctions (tests on temp folders)
- [ ] A non-repo, a repo with no commits, and a repo off its default branch each get the right answer (refusal with the fix, or Initialise)
- [ ] + Project → Import registers a Project picked from the tree or typed, and works at phone width
- [ ] The Knowledge store fields use the browser
