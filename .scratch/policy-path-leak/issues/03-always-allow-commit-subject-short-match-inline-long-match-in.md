# 03: Always allow commit subject: short match inline, long match in body

**What to build:** In alwaysAllow (packages/core/src/policy/policy.ts) build subject `Kiln: always allow ${action} ${JSON.stringify(match)}`; if the match has no line break and the subject is at most 72 characters, use it as the whole message. Otherwise the subject is `Kiln: always allow ${action} (a long rule)` and, after a blank line, the raw match (not JSON-quoted) is the body. Permission review subject unchanged. publish.ts and existing rules untouched. Tests via startTestKiln: short command commits with the full subject; long or multi-line one ends `(a long rule)` with the match in the body (git log -1 --format=%B in the temp repo).

**Blocked by:** None

**Status:** needs-triage
