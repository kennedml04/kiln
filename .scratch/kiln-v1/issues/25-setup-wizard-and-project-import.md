# 25: Setup wizard and Project import

**What to build:** A first-run wizard in the Shell, which Admins can re-run. It walks through:

1. The login mode (Local or Tailscale).
2. The Knowledge store folder. It checks whether Obsidian is installed and suggests it if not, without requiring it.
3. Work or home install, with the matching default Budgets: a work install gets a metered 10,000-credit monthly Budget; a home install gets a Claude Max subscription Budget, plus a local Budget if a local model server is found. All their limits are shown and can be edited.
4. Installing the first-party Agent Widgets.
5. Which models belong to which Budget.
6. The model and fallback for each default Workflow role, with no silent expensive default.
7. A one-time import of the Projects registered on the old board.

The import reads the old board's Project registry read-only and never writes to the old board's folder or data. Each imported Project uses the markdown Tracker, and its existing `.scratch` work shows up as-is.

**Blocked by:** 11, 15, 17, 18, 19

**Status:** resolved

- [ ] A fresh data folder opens the wizard, and finishing it leaves a working Kiln with Budgets, Agents and models set
- [ ] Work and home installs get their matching default Budgets with editable limits
- [ ] The Obsidian check only suggests installing it, never requires it
- [ ] Each default Workflow role must have a model chosen
- [ ] The import registers the old board's Projects, and a test proves the old board's folder is never written (it runs against a copy)
- [ ] Imported Projects show their `.scratch` Items
