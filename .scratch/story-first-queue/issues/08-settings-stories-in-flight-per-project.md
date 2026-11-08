# 08: Settings: Stories in flight per Project

**What to build:** SettingsPage.tsx gets a "Stories in flight" block beside the pools: a number input per Project (0-10) for Admins, read-only text for Members and Viewers, and a line showing the box-wide cap ("at most N across all Projects: the agents pool size"). Changing it calls PUT /api/scheduler/story-limits/:projectId and updates GET /api/scheduler. Shell test 11. Depends on ticket 04.

**Blocked by:** None

**Status:** done

**Stage:** shipped
