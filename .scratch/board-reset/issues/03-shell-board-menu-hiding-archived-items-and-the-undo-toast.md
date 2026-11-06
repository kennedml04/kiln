# 03: Shell: Board menu, hiding archived Items and the Undo toast

**What to build:** Add BoardMenu (⋯, aria-label 'Board menu', 44px tap target) with Reset board (hidden for Viewers, disabled 'Nothing in Shipped') and a Shipped history link, on Home (new 'Board' toolbar row) and beside the Project name on a Project's board. HomeBoard and ProjectView drop Items with archived set before grouping. Add a Shell-level toast area above the router (role=status, bottom right on desktop, full width on phone): 'Archived N shipped Items.' with Undo and dismiss, 10s, Undo calls unarchive by batch then shows 'Put back N Items.' for 3s; errors shown too. Playwright tests at desktop and phone width.

**Blocked by:** None

**Status:** in-review

**Stage:** implementing
