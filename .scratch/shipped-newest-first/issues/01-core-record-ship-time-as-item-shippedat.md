# 01: Core: record ship time as Item.shippedAt

**What to build:** Add `shippedAt?: string` to `Item` in packages/widget-sdk/src/work.ts. In Work, cache the latest `item.stage_changed` time per Item and target Stage (one events query at start, updated from the bus), fill `shippedAt` in `toItems`/`remark` when the Item is shipped, and after `moveTo` publishes `item.stage_changed` set it and publish `item.updated`. Core tests via startTestKiln (ship, roll-up, not shipped, rework, no record, restart). Add "Ship time" to GLOSSARY.md.

**Blocked by:** None

**Status:** needs-triage
