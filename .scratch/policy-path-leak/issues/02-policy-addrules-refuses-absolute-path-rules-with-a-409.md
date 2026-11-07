# 02: Policy addRules refuses absolute-path rules with a 409

**What to build:** At the top of addRules in packages/core/src/policy/policy.ts, before readFileLayer and commitOnly, throw WorkError(409) if any rule's match makes namesAbsolutePath true (message names the action, does not repeat the path). Whole call refused, no partial write or commit. Covers alwaysAllow and the Permission review route. Tests through startTestKiln: Always allow answered by hand via the API on a /tmp match gets 409, .kiln/policy.json unchanged and no new commit; Permission review posting a chosen rule naming /tmp/x gets 409 and nothing committed. Depends on the namesAbsolutePath ticket.

**Blocked by:** None

**Status:** needs-triage
