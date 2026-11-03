# Work is core: one work model, many views

Kiln's core is three blocks: the Shell (the main board), Work (Projects, their items, one lifecycle, agent sessions) and the Platform (identity, roles, audit, hosting Widgets, events). Everything else is a Widget. The old board kept two separate work models, the card board and the Epic board, each with its own states, and synced them; that sync is where the mess came from. Now the main board and each Project's board are two views, with different filters, of the same items in the same states. Work is not a Widget because the other Widgets need a shared language to plug into (for example, raising a Needs you ask on a ticket). What stays modular is the **Workflow**: each Project picks its Stages and the agent role at each Stage, so a corporate team's flow and the default Grill → Spec → Tickets → Implementing → Review flow both fit.

## Considered options

- **Keep two boards with separate logic** (the old design): rejected; the duplicated state and the syncing between them caused the confusion and the mess.
- **Make Projects/Work a Widget**: rejected; every other Widget would depend on it, so it would be core in practice.
