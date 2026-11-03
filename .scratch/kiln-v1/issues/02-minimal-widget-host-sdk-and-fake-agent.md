# 02: Minimal Widget host, SDK and scripted fake Agent

**What to build:** The core can run a Widget. Given a local folder with a Manifest, the core starts the Widget as its own process and passes it the core API's address and a per-Widget credential. The Widget registers and reports ready. The core can stop it again without restarting itself. A first cut of the TypeScript Widget SDK provides a typed API client, the Manifest types and the Agent interface: start a Session, send a message, interrupt, resume, stop, and the events coming back (progress, permission request, usage per turn, quota reading, Digest written, finished). On top of the SDK sits a scripted fake Agent Widget. It follows a script supplied by the test (make these edits in the worktree, commit, report this usage or quota reading, repeat this tool call, raise this Ask, finish). The test harness can install it into a test core, which completes the core-API test seam.

**Blocked by:** 01

**Status:** resolved

- [ ] The core starts a Widget from a local folder using its Manifest and stops it without a core restart
- [ ] Each Widget gets its own credential, and calls without a valid credential are refused
- [ ] The Widget SDK exposes typed Manifest, API client and Agent interface definitions shared with the core
- [ ] The fake Agent registers as an Agent and runs a script given by the test
- [ ] The harness can install the fake Agent into a test core in one call
- [ ] A harness test starts the fake Agent and receives its registration event over SSE
