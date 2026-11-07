# 02: Unarchive, archive history API and the clearing rule

**What to build:** Add POST /api/archive/unarchive {batchId}|{itemIds} (Member, audited as archive.unarchive, events archive.unarchived and item.updated) and GET /api/archive?projectId=&q= (Viewer; batches newest first with still-archived Items, q matches title or key, skips Items gone from the Tracker). Add the clearing rule: when an archived Item's runState is not shipped (on item.updated, item.stage_changed, and at core start) delete its mark, publish item.updated without archived, and audit archive.cleared. Tests: undo by batch, single Unarchive, re-Reset, clearing incl. restart, roll-up unaffected, roles.

**Blocked by:** None

**Status:** done

**Stage:** shipped
