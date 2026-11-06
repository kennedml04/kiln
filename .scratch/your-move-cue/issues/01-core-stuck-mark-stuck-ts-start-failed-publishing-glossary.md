# 01: Core: Stuck mark, stuck.ts, start_failed publishing, glossary

**What to build:** Add the stuck_items table and migration (with the one-off seed from the events log), packages/core/src/flow/stuck.ts (bus listeners that set and clear the mark; plain-words reason table matched on the real WorkError messages), `stage` and `reason` on scheduler.start_failed, and publishing of start_failed from the Start route and Thread message start on real failures only. Add Stuck and Your move to GLOSSARY.md. Tests in packages/core/test/stuck.test.ts for set, clear, restart, Stop all, NOT_READY, hand-added Backlog and the seed.

**Blocked by:** None

**Status:** needs-triage
