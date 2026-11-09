# 01: Up/down buttons on Up next cards (Members/Admins only)

**What to build:** In UpNext (packages/shell/src/work/HomeBoard.tsx) add a ▲ ▼ group in each card's top-right corner at every width, with 44px hit areas, aria-labels "Move <title> up/down", draggable=false, title padding so it never covers the title. Add a move(id, to) helper that sends the whole shown order (only Items in scheduler.queue) through the same send-and-error path as dropBefore; no optimistic reorder; all buttons disabled while a PUT is in flight; first ▲ / last ▼ / unknown-queue cards disabled; error shown in the column alert, cleared by a later success; focus stays on the moved card's button (or its other button if disabled). Hidden for Viewers. Shell tests on a 390x844 viewport in packages/shell/test/scheduler.test.ts: ▼ moves first card second (page and GET /api/scheduler), disabled ends, new Ticket joins last with order unchanged, Viewer sees none, a move for a card that just left the queue shows the error, existing drag test still passes on wide.

**Blocked by:** None

**Status:** in-review

**Stage:** review
