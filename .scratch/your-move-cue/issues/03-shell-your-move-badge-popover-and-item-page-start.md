# 03: Shell: Your move badge, popover and Item page Start

**What to build:** Show a "Your move: Start" badge on every card of an Item with `stuck` (Home board, Project board, Item page header). The reason is in its title and accessible description; tapping opens a popover with the reason and a Start button that calls POST /api/items/:id/start. Dark theme, existing badge styles. Tests in packages/shell/test/your-move.test.ts: badge with reason, Start from the popover starts the Session and the badge goes away.

**Blocked by:** None

**Status:** needs-triage
