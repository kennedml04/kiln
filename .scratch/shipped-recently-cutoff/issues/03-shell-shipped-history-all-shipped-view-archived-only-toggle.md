# 03: Shell: Shipped history All shipped view + Archived only toggle

**What to build:** Widen ShippedHistory (/shipped, /projects/:id/shipped): add shippedPath(projectId?, view?) and a toggle 'All shipped' (default) / 'Archived only' kept in ?view=archived. All shipped is built from store Items with runState 'shipped' (archived or not), sorted by byShippedNewest, filtered by Project select and 250ms-debounced title/key search; rows show Project (all-Projects page), kind, title link, key, ShippedAge, and for archived Items an 'Archived' mark and Unarchive (not for Viewers). Empty text 'Nothing has shipped yet.' / 'No shipped Items match.'. Archived only keeps today's Reset batch view unchanged (GET /api/archive, Unarchive, Unarchive batch). The cut-off is not applied here; the ⋯ menu entry is unchanged. Playwright tests: Show all link from a Project board lands on that Project's All shipped view with archived marked; Archived only shows Reset batches with Unarchive batch working; after a Reset archived Items leave the board and aren't counted in N; Viewer has no Unarchive. Depends on the Shell cut-off Ticket.

**Blocked by:** None

**Status:** needs-triage
