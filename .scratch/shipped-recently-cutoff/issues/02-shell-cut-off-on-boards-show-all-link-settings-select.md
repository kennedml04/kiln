# 02: Shell: cut-off on boards, Show all link, Settings select

**What to build:** Shell store loads GET /api/board-settings and follows board_settings.updated (default 7 until loaded). Add cutShipped(items, window, now) -> {shown, hidden} in shipped.ts with node --test unit tests (inside/just past window, no shippedAt hidden, future shown, 'off' shows all with unshipped-time last and hidden 0, newest first). Apply on HomeBoard's shipped group and the last-Stage column of each ProjectView kind row, driven by useMinuteClock without re-rendering every card (ItemCard stays memoised); column count = shown. Render 'Show all (N older)' link (hidden when N=0, 44px on phone; Project's shippedPath(projectId) or Home's shippedPath()) and the empty line 'Nothing shipped in the last N days' ('day' for 1) only when the cut-off hides something. Add Admin-only 'Board' section on SettingsPage with a 'Shipped recently shows' select (1/3/7/14/30 days, Off), saving on change with error display. Playwright tests (desktop and phone, browser clock to age Items) per spec Testing Decisions. Blocked by Story 'Shipped newest first' (Item.shippedAt, byShippedNewest, useMinuteClock, ShippedAge); depends on the core settings Ticket.

**Blocked by:** None

**Status:** needs-triage
