# 04: Register a Project and see its Items

**What to build:** A person registers a Project by pointing Kiln at a repository, either through the API or a form in the Shell. Kiln uses the default Workflow (Epic, Story, Ticket and their Stages) and the markdown Tracker. The Tracker reads the existing `.scratch` layout as-is: Story folders with story, spec and numbered Ticket files, and Epics in their own folder. Items keep their parent and child links. The Shell's home is the all-Projects board, grouped by run state (Backlog, Up next, Running, Waiting, Shipped recently). Each Project has a view whose columns are its Workflow's Stages, one row group per Item kind. Both boards are views of the same Items, update live over SSE and patch only what changed. A person can also create an Item from the Shell, which the markdown Tracker writes into the repo.

**Blocked by:** 01

**Status:** resolved

- [ ] Registering a temp repo that has an existing `.scratch` layout shows its Epics, Stories and Tickets with their parents and children
- [ ] The all-Projects board and the Project view show the same Items in the same Stages
- [ ] Editing an Item file in the repo updates both boards live without a page reload
- [ ] Creating an Item from the Shell writes it to the repo in the `.scratch` layout
- [ ] Dragging an Item between Stage columns is refused
- [ ] A browser test covers the home board and the Project view
