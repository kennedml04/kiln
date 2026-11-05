# 02: Unregister a Project

**What to build:** A core ability Kiln lacks today: `work.unregister(projectId)`. It stops every running Session on the Project, removes the Project's worktrees and branches that Kiln created, deletes its DB row and publishes `project.removed`. Its Items disappear from every board view. It does not delete the repo folder; the caller decides that. There is no UI and no general route; the demo (05) is its only caller for now. See "Demo setup (core)" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Unregistering a Project with a running Session stops that Session first and records why in its Thread
- [ ] The Project's Kiln worktrees are removed; the repo folder itself is left in place
- [ ] The DB row is gone, `project.removed` is published, and the Project's Items no longer appear on the all-Projects board
- [ ] The same folder can be registered again afterwards as a new Project
- [ ] Tests in `packages/core/test/projects.test.ts`
