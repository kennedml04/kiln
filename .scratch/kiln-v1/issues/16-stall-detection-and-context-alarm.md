# 16: Stall detection and context alarm

**What to build:** Two runaway guards that apply to every Budget kind. Stall detection pauses a Session and raises a blocking Ask when it has gone 8 consecutive turns with no new commit and no artifact change, or has made the same tool call with the same arguments 3 times in a row. The context alarm fires when a Session's context passes the lower of 300k tokens and 60% of the model's context window. The Session pauses, writes a Digest, and carries on as a fresh Session seeded from artifacts and Digests, with no Ask. The thresholds are settings an Admin can change.

**Blocked by:** 10, 15

**Status:** resolved

- [ ] 8 turns with no commit and no artifact change pauses the Session and raises an Ask
- [ ] 3 identical tool calls in a row pauses the Session and raises an Ask
- [ ] Passing the context threshold makes the Session write a Digest and continue as a fresh Session without an Ask
- [ ] The thresholds are configurable, and the defaults match the spec
