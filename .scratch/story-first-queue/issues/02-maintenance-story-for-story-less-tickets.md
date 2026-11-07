# 02: Maintenance Story for Story-less Tickets

**What to build:** work.ts gives every Ticket with no parent the Project's Maintenance Story as parentId (creating it the first time: .scratch/maintenance/story.md with title Maintenance, stage tickets, maintenance: true; for Widget Trackers create via the Tracker and remember the id in a maintenance_stories table). createItem for a parentRequired kind whose parent kind is story and no parentId files under Maintenance instead of 400. Maintenance never rolls up to Shipped, never runs its own Session, and edits moving it to another Stage get 409 "The Maintenance Story stays open". Tests: POST ticket without parent succeeds; a .scratch/items/ticket file without parent gets the same parent; it never ships. Depends on the Items ticket (maintenance flag).

**Blocked by:** None

**Status:** needs-triage
