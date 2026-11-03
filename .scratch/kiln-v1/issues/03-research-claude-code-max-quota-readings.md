# 03: Research: where Claude Code exposes Max plan quota readings

**What to build:** A findings doc that answers how a Kiln Agent Widget wrapping Claude Code (through the Claude Agent SDK) can read the Claude Max plan's usage windows: the 5-hour window, the weekly window, and Fable's own weekly allowance. For each window, find whether percent used and reset time are available, from which source (SDK messages or results, rate-limit events, the status line input, the `/usage` command, response headers, or anything else), how often they update, and whether they are reported per model. Use primary sources (official docs, the SDK's types, and observing a real run on a cheap model). Write down what the spec's subscription Budget can rely on and what it can't. If a reading isn't available, propose the fallback (the Budget shows "unknown", per the spec).

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] A findings doc in the repo's research folder with the source for each window (5-hour, weekly, Fable weekly), the fields available and how fresh they are
- [ ] Each claim links a primary source or a recorded observation
- [ ] A clear verdict for each window: reliable, partial or unavailable
- [ ] A note of any change the spec's subscription Budget or the Agent interface's quota reading event needs
- [ ] Any real run used for observation stays under a few cents of usage
