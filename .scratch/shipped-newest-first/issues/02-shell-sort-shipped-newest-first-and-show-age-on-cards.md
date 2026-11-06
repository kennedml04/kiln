# 02: Shell: sort Shipped newest first and show age on cards

**What to build:** Add packages/shell/src/work/shipped.ts with `byShippedNewest` (stable; no-time Items last) and `shippedAge` (just now / Nm / Nh / Nd ago / date). Apply to Home's Shipped recently and each last-Stage column in ProjectView. Show a `<time title=exact>` age on shipped cards via a small ShippedAge component on a shared minute clock. Unit tests plus Playwright at desktop and phone widths. Depends on the core ticket (Item.shippedAt).

**Blocked by:** None

**Status:** needs-triage
