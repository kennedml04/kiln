# 01: Archive service, Item.archived and POST /api/archive/reset

**What to build:** Add archive_batches and archived_items tables (migration in packages/core/src/db.ts) and packages/core/src/work/archive.ts with reset(). Add Item.archived {at, batchId} to the SDK and fill it in Work. POST /api/archive/reset {projectId?} archives every shipped Item (Project or all), 409 'Nothing in Shipped', Member-only in access.ts, audited as archive.reset, publishes item.updated per Item and archive.reset. Repo and Tracker untouched. Add 'Archived' and 'Shipped history' to GLOSSARY.md. Tests per the spec: scope, repo untouched, empty, roles, audit, events.

**Blocked by:** None

**Status:** done

**Stage:** shipped
