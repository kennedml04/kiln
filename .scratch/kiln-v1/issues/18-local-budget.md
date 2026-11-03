# 18: Local Budget

**What to build:** The Budget kind for models served on this machine through an OpenAI-compatible endpoint. It involves no money. Each Session is capped at 300 turns or 2 hours of wall time (defaults), counting subagents, and hitting a cap pauses the work and raises a blocking Ask. Sessions on a local Budget take a slot in the gpu pool (default "gpu: 1") as well as their Stage's pool. Nothing in a local Budget assumes Windows or NVIDIA, so it works the same on an Apple Silicon laptop. The header shows running local Sessions. Local work keeps running when another Budget is paused.

**Blocked by:** 14, 15

**Status:** resolved

- [ ] Local Sessions record usage with no money cost and are capped by turns and wall time
- [ ] Hitting a local cap pauses the Session and raises a blocking Ask
- [ ] Local Sessions take a gpu pool slot, so with "gpu: 1" they never run two at a time
- [ ] Local work keeps going while a subscription or metered Budget is paused
- [ ] No platform-specific assumption (Windows or NVIDIA) exists in the local Budget
