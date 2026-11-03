# 26: Operations: doctor, dev instances, Restart when idle and start at login

**What to build:** The tools for running Kiln day to day and for developing Kiln with Kiln.

- `kiln doctor` checks the port, data folder, Widget health, git, the Agents, the Knowledge store, and subscription Budgets with no readings, and reports each problem in plain words.
- A dev-instance command starts a core from a given worktree on a free port with a throwaway data folder, so a Session changing Kiln's own core can test the change without touching the live Kiln.
- Agents can never restart the live core. Updating the core is a person's action, "Restart when idle", available from the Shell and the CLI: Kiln waits until no Sessions are running, then restarts itself.
- Kiln starts at user login as one per-user startup entry, with no tray, watchdog or recovery processes.

**Blocked by:** 05, 19

**Status:** resolved

- [ ] `kiln doctor` reports each check as pass or fail, with a plain fix for each failure
- [ ] A dev instance runs from a worktree on its own port and throwaway data folder, alongside the live core
- [ ] No API or tool lets a Session or Widget restart the live core
- [ ] Restart when idle waits for running Sessions to finish, then restarts
- [ ] Kiln starts at login through one startup entry
