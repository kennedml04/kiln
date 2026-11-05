# 08: The "Start demo" button and the Replay note

**What to build:** In `packages/shell/src/work/ProjectView.tsx`, the Project whose id matches `GET /api/demo`'s `projectId` shows a "Start demo" button with a Replay/Live choice. It calls `POST /api/demo/start` after a confirmation, shown in the page and not as a browser dialog, that the current demo run will be thrown away. On a dev instance with no demo Project, the all-Projects view offers "Add the demo" in the same way.

While the mode is Replay, a short note on the demo Project says what to do: answer the Asks in Needs you, approve the Gates, and approve Ticket 01's Review before Ticket 02 starts. The last part stays until the scheduler enforces `Blocked by`. See "The demo Project in the Shell" in `spec.md`.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The button appears only on the demo Project, and only on a dev instance
- [ ] Confirming starts a fresh demo in the chosen mode, and the view shows the new Story at Grill without a page reload
- [ ] A start error (Live with a role unset, a refused Widget source) is shown next to the button
- [ ] The Replay note shows in Replay and not in Live
- [ ] "Add the demo" appears on a dev instance with no demo Project and disappears once it is added
- [ ] Shell tests in `packages/shell/test/boards.test.ts`
