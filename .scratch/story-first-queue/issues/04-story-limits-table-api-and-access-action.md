# 04: Story limits: table, API and access action

**What to build:** Add story_limits table (default 2 when no row), Scheduler.setStoryLimit(projectId, size) (404 unknown Project, 400 unless whole number 0-10), PUT /api/scheduler/story-limits/:projectId {limit}, new scheduler.story_limit action in access.ts (Admin only), and the box-wide cap read live from the Ticket kind's first-Stage pool size (a Project with no ticket kind is not limited). Expose limits {perProject, boxWide} on SchedulerState/GET /api/scheduler and scheduler.updated. Raising the limit dispatches at once. Test 9 (403 for Member, 400 for 11 and 1.5, default 2).

**Blocked by:** None

**Status:** needs-triage
