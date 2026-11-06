# 02: Remove perSession.share; add guard settings

**What to build:** In widget-sdk budgets.ts and core kinds.ts: perSession becomes {turns}; configure silently ignores an old perSession.share; drop the session-share limit (and sessionShare / usage.ts quota measure if unused); update error text and defaults docs. Add guard {share default 20 (0=off, percentPoints allowZero), hours default 12 (whole 1-168)} to SubscriptionBudgetConfig, defaults and validation (400 naming the field; missing guard takes defaults). Tests: old config with share still loads and PUT stores no share; no session-share limit; bad guard values 400; share=0 accepted.

**Blocked by:** None

**Status:** needs-triage
