# 04: Shell: Shipped history pages and Archived badge on the Item page

**What to build:** Add routes /shipped (with Project filter) and /projects/:id/shipped in App.tsx. Page lists Resets newest first (when, who, scope, N Items, M still archived) with Unarchive batch, and Items (Project, kind, title, key, link, Unarchive); debounced title/key search sent as q; refetch on archive.* events; Unarchive hidden for Viewers; 0-still-archived batches stay listed. ItemView shows an 'Archived <when>' badge and Unarchive button. Playwright tests: list, search, Unarchive, Unarchive batch, badge.

**Blocked by:** None

**Status:** in-review

**Stage:** implementing
