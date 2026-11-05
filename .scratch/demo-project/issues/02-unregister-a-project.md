# 02: Unregister a Project

**What to build:** A core ability Kiln lacks today: `work.unregister(projectId)`. It stops every running Session on the Project, removes the Project's worktrees and branches that Kiln created, deletes its DB row and publishes `project.removed`. Its Items disappear from every board view. It does not delete the repo folder; the caller decides that. There is no UI and no general route; the demo (05) is its only caller for now. See "Demo setup (core)" in `spec.md`.

**Blocked by:** None

**Status:** resolved

- [x] Unregistering a Project with a running Session stops that Session first and records why in its Thread
- [x] The Project's Kiln worktrees are removed; the repo folder itself is left in place
- [x] The DB row is gone, `project.removed` is published, and the Project's Items no longer appear on the all-Projects board
- [x] The same folder can be registered again afterwards as a new Project
- [x] Tests in `packages/core/test/projects.test.ts`

Tests reach `work.unregister` through a test-only route, `POST /api/test/projects/:id/unregister` (test cores only), via `kiln.unregisterProject(id)` in the harness. The Project's Session rows and Up next entries go with it, so a re-registered folder starts clean; its Digests in the Knowledge store and its past events stay.
