# 01: Core: board settings API (shipped window)

**What to build:** Add ShippedWindow/BoardSettings types to widget-sdk (default 7). Store in core_settings row 'board'; unknown/missing reads as default. Add GET /api/board-settings (Viewer) and PUT (Admin, 400 on bad value "shippedWindow must be 1, 3, 7, 14, 30 or off", audit board_settings.update {from,to}), register both in access.ts, publish board_settings.updated on the bus. API tests via startTestKiln: default 7, round-trip and survive restart, Member/Viewer PUT refused, Viewer GET ok, 400, event and audit. Also update GLOSSARY.md (reword Shipped history; add Shipped cut-off) and add a dated superseded note under decision 6 in .scratch/board-reset/grill.md pointing to this Story.

**Blocked by:** None

**Status:** needs-triage
