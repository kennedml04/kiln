# 03: Runaway guard rule and QuotaStore.attributedSince

**What to build:** Add QuotaStore.attributedSince(budgetId, config, 'week', since) summing Kiln-attributed week share over pairs whose later reading is within the window (0 if none). Add rule 'guard' in subscription-rules.ts (also in quota.hold/quota.released rule unions): checked after each stored reading and on the timer; trips when total > mark (mark starts at guard.share); holdAll with one blocking Ask 'Continue for another N%' (mark = total + N, release, no waiver) or 'Stop' (stopAll; new starts stay held, no new Ask, until total falls to/below mark); mark resets to guard.share when total falls to/below it; no second Ask while held; guard.share 0 = off. Tests per spec items 1-6 (small Session with high week total never trips; person's own use doesn't count; trip pauses running + holds new + one Ask; Continue; Stop; roll-off over >12h). Depends on the reset-fix and settings tickets.

**Blocked by:** None

**Status:** in-review

**Stage:** review
