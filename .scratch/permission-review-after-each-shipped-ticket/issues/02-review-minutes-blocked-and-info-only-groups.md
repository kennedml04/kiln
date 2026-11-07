# 02: Review: minutes blocked and info-only groups

**What to build:** Spec section 2. In packages/core/src/policy/permission-review.ts and the PermissionReview type in widget-sdk: add minutes (sum of answeredAt-raisedAt, whole minutes, '<1 min') per ProposedRule, a total (asks, minutes) and info[] {action,label,reason,asks,minutes,examples} for answered Asks no rule can fix (names a local folder, one-off, Org/Stage Policy asks, kills by name, was denied). Text opens '39 Permission Asks on this Ticket, 858 min blocked.', each group reads 'N Asks, M min blocked'; proposed rules first sorted by minutes (ties by Ask count, then match), then 'No rule can fix these:' info groups, then warnings. Info groups and warnings never raise a review Ask alone; one is raised only when at least one rule or fold exists. Tests: controlled raisedAt/answeredAt through the API show total, per-group minutes, order and reasons; an Item with only info-only Asks raises no review Ask.

**Blocked by:** None

**Status:** needs-triage
