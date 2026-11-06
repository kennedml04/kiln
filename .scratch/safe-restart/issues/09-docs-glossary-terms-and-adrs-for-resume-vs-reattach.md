# 09: Docs: GLOSSARY terms and ADRs for resume vs reattach

**What to build:** GLOSSARY.md: add 'Pause after this turn', 'Stop now', 'resume token'; drop 'Restart when idle'. New ADR recording why Sessions survive by resuming the saved conversation rather than keeping Agent processes alive, and that the resume token is opaque to the core. Update ADR 0004's Agent interface list for the 'paused' finish reason, pause_after_turn and the resume token event.

**Blocked by:** None

**Status:** needs-triage
