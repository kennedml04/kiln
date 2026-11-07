# 06: Shell: Story cards, Story-ordered Up next and Running

**What to build:** New StoryCard (title, Epic, Stage, "N of M shipped", sub-row with running / waiting-on-me / next Ticket; Maintenance reads "N shipped, K open"). UpNext in HomeBoard.tsx renders scheduler.stories that aren't running; drag and ▲ ▼ send Story ids (with projectId on a Project board, ProjectView.tsx). Running groups by Story with the running Ticket(s) as sub-rows; Shipped recently shows Stories, Tickets only for Maintenance. Opening a Story lists its Tickets in number order in its Thread. Dark theme first. Update existing up-next-reorder Shell tests to move Story cards; add Shell test 10 (Story cards only, shipped count, running sub-row). Depends on tickets 03 and 05.

**Blocked by:** None

**Status:** in-review

**Stage:** review
