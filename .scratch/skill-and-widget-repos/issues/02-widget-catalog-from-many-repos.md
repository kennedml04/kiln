# 02: A Widget catalog from an ordered list of Widget repos

**What to build:** An Admin keeps an ordered list of Widget repos: the public repo by default, plus any number of private ones (a company's, or the owner's own private GitHub repos). Kiln reads every repo on the list and shows the Widgets it finds on an "Available" tab, so an Admin can browse and install Widgets from all of them without typing a source. Nothing is installed or run until an Admin installs it. Grilled 2026-11-03.

Decisions:

1. **The setting.** `widgetRepos` is an ordered list of Widget sources, each a git URL or a local folder, with an optional folder inside the repo (default `widgets/`). Unset, it is `["https://github.com/kennedml04/kiln.git"]` (`PUBLIC_WIDGET_REPO`). An Admin can add, remove and reorder entries. The existing single `widgetRepo` setting becomes a one-entry list; Widgets already installed keep their pins.
2. **The Widget source policy still decides.** An entry the Org Policy's `widgetSources` doesn't allow is refused when added, and is shown as blocked if the Policy changes later.
3. **Pinned catalog.** Kiln pins each repo on the list to one commit and builds the catalog from that commit. When the repo has moved on, the Shell shows "update available" for that repo; an Admin approves it and the catalog moves to the new commit. Installed Widgets update through their existing update flow, not through this.
4. **What the catalog shows.** Every `<folder>/<name>/kiln-widget.json` in each repo: the Widget's name, id, version, which repo it comes from, and what its Manifest needs (network hosts, Secrets, Asks, data folder). A Widget that is already installed is marked installed.
5. **Install stays explicit.** Install from the catalog runs today's install flow, including the Admin's approval of what the Widget needs. A missing or broken Manifest shows as an error on that catalog entry, not a failure of the whole catalog.
6. **Name clashes go by list order.** When two repos have a Widget with the same id, the one from the higher repo is offered. The lower one is shown greyed out with the reason, for example "not offered: acme/widgets is higher in the list and has a Widget with this id".
7. **Setup uses the catalog.** The setup wizard's first-party Agents list becomes the Agent Widgets found across all listed repos, instead of a fixed list from one repo.
8. **Fetches** use ticket 01's rules (no prompts, timeout, tokens, check access when a repo is added).

**Blocked by:** 01 (safe git fetches).

**Status:** ready-for-agent

- [ ] With no setting, the catalog lists the public repo's Widgets
- [ ] Adding a second repo (a local temp git repo in tests) adds its Widgets to the catalog; removing it takes them away; installed Widgets stay installed
- [ ] Reordering the list changes which copy of a same-id Widget is offered, and the other copy shows greyed out with the reason
- [ ] A repo the Widget source policy doesn't allow can't be added, and an existing one shows as blocked when the Policy changes
- [ ] A push to a listed repo shows "update available"; the catalog doesn't change until an Admin approves it
- [ ] Installing from the catalog asks for the same approvals as installing by source
- [ ] One repo with a broken Manifest doesn't hide the others' Widgets
- [ ] The setup wizard offers Agent Widgets from every listed repo
- [ ] An existing `widgetRepo` setting is read as a one-entry `widgetRepos` list
