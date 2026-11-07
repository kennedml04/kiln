# 06: Pi usage, context window, cache and compaction reporting

**What to build:** Report per-turn usage (input, output, cache-read, cache-write tokens, model, cost in the Budget's unit; no cost for local models), the model's contextWindow and per-turn context tokens, and the prompt-cache lifetime from Pi's own table, with Pi's keep-warm refresh turned off. Keep auto-compaction on and show each compaction in the Thread as a progress event, e.g. "Pi compacted context: 41k → 9k tokens".

**Blocked by:** None

**Status:** needs-triage
