# 03: Story order and Story-id reorder API

**What to build:** Add story_order table (story_id, project_id, position) with join-at-bottom rules, removal on ship/remove/project.removed, and a first-start migration seeding from existing queue entries. reorder(order, projectId?) takes Story ids (Ticket ids accepted as a one-release shim mapped to their Story; 409 for non-waiting ids; projectId variant reorders only that Project's Stories within their own positions, 400 for other Projects' Stories). ReorderQueueRequest gains projectId?; stop writing priority; proposals with an order go through the same reorder. Tests 2 and 3 of the spec's Testing Decisions.

**Blocked by:** None

**Status:** done

**Stage:** shipped
