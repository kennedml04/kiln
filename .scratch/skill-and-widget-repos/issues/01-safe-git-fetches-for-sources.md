# 01: Safe git fetches for Widget and Skill sources

**What to build:** Every git fetch Kiln makes from a source (a Widget install or update today, the Widget catalog and Skill sources in later tickets) runs without prompts, with a timeout, and off the core's main loop. An Admin can give a source an optional token. When Kiln can't reach a private repo, the Admin gets a clear refusal within seconds and the core never freezes. Grilled 2026-11-03.

Today the clone in the Widget source code runs `git` synchronously with no timeout. If git has no stored login for a private repo, it can wait on a password prompt or a Git Credential Manager window, and the whole core waits with it.

Decisions:

1. **The PC's own git login is the default.** If `git clone` of the repo already works on this PC (Git Credential Manager, an SSH key), Kiln needs nothing more.
2. **An optional token per source.** An Admin can attach a token to a source URL, for example a GitHub fine-grained token with read-only access to that repo. Kiln keeps it in the OS credential store (the same store Widget Secrets use) and hands it to git only for fetches from that source, through a credential helper or an `http.extraHeader` passed on the command line. The token never goes into Kiln's files, settings, the audit log, error messages or git's own config.
3. **No prompts, ever.** Every fetch runs with `GIT_TERMINAL_PROMPT=0` and Git Credential Manager set to non-interactive, so a missing login fails instead of waiting.
4. **A timeout.** A fetch that runs longer than a set limit is killed and reported (default 2 minutes; a large repo may need more).
5. **Off the main loop.** Fetches run asynchronously. Other API calls keep answering while one runs.
6. **Clear failures.** An auth failure reads like "Can't reach https://github.com/acme/skills.git: authentication needed. Log in with git on this PC or add a token for this source." A timeout or a missing repo gets its own message.
7. **Check access.** An Admin can ask Kiln to check a source before using it. The check is cheap (`git ls-remote`), uses the same login rules as a fetch, and returns ok or the same clear failure.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A Widget install from a git source that needs a login no one has given fails with the authentication message within seconds, and no prompt or window appears
- [ ] While a slow fetch runs, other API calls answer normally
- [ ] A fetch that runs past the timeout is stopped and reported as a timeout
- [ ] A token attached to a source lets Kiln fetch a repo that needs it, and the token appears in no Kiln file, setting, audit row, log line or error, and not in the clone's git config
- [ ] A token can be replaced and removed; removing it falls back to the PC's git login
- [ ] Check access answers ok for a reachable source and the clear failure for an unreachable one
- [ ] Tests use a local git server or a fake credential helper, never real GitHub or the PC's real git credentials
