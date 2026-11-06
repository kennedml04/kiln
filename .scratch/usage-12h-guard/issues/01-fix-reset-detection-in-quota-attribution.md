# 01: Fix reset detection in quota attribution

**What to build:** In packages/core/src/budgets/quota.ts `attribute`, count a reading pair as a reset only when resets_at moves later by more than 1 hour; otherwise use the ordinary delta (skip if <=0). Tests: jittering resets_at (ms) with week at 89->90% attributes 1, not 90; a pair whose resets_at moves by days still credits the new reading whole.

**Blocked by:** None

**Status:** needs-triage
