# 03: Skill repos and the Skills list

**What to build:** An Admin keeps an ordered list of Skill repos: the public repo by default, plus any number of private ones. Kiln reads the Agent skills (`SKILL.md` folders) from each repo at a pinned commit and shows them in a Skills list in the Shell, with an on/off switch per skill. This ticket stops at the list and the switches; ticket 04 hands the skills to Sessions. Grilled 2026-11-03.

Decisions:

1. **What a Skill is.** A folder holding a `SKILL.md` (the format Claude Code and OpenCode both read), plus any files beside it. The skill's name is its `SKILL.md` frontmatter `name`, falling back to the folder name.
2. **The setting.** `skillRepos` is an ordered list of Skill sources, each a git URL or a local folder, with an optional folder inside the repo (default `skills/`, so a skill lives at `skills/<name>/SKILL.md`). Unset, it is `["https://github.com/kennedml04/kiln.git"]`, the same default as `widgetRepos`. An Admin can add, remove and reorder entries. A repo with no skills folder lists no skills and is not an error.
3. **Skill source policy.** The Org Policy gets `skillSources` beside `widgetSources`, with the same shape and matching rules. Unset, any source is allowed. An entry it doesn't allow is refused when added and shown as blocked if the Policy changes later.
4. **Pinned, updated on approval.** Each repo is pinned to one commit, checked out read-only in Kiln's data folder. When the repo moves on, the Shell shows "update available" for it; an Admin approves and the repo's skills move to the new commit. A push never changes the skills on its own.
5. **On by default, one switch each.** A skill is on as soon as its repo is added. An Admin can turn any skill off, install-wide. The switch is remembered by repo and skill name, so it survives an update.
6. **Name clashes go by list order.** When two repos have a skill with the same name, the one from the higher repo is used. The lower one is shown greyed out with the reason, for example "not used: acme/skills is higher in the list and has a skill with this name". Turning the winner off makes the next one down the one used.
7. **Who sees what.** Admins change the list, the switches and the updates. Members can see the Skills list, each skill's state and why.
8. **Fetches** use ticket 01's rules.
9. **Domain docs.** Add **Skill**, **Skill source** and **Skill source policy** to `GLOSSARY.md`, next to their Widget counterparts. Record the decision (pinned Skill sources, delivered by Kiln, list-order priority) as a new ADR beside ADR 0008.

**Blocked by:** 01 (safe git fetches).

**Status:** ready-for-agent

- [ ] With no setting, the Skills list shows the public repo's skills, or none if it has no `skills/` folder, without an error
- [ ] Adding a second repo (a local temp git repo in tests) adds its skills; removing it takes them away
- [ ] Two repos with a same-named skill: the higher one is used and the lower one shows greyed out with the reason; reordering swaps them; turning the winner off makes the other one used
- [ ] A skill switched off stays off after its repo updates
- [ ] A push to a listed repo shows "update available"; the skills don't change until an Admin approves it
- [ ] A repo the Skill source policy doesn't allow can't be added, and an existing one shows as blocked when the Policy changes
- [ ] A Member can see the list but gets a refusal changing it
- [ ] `GLOSSARY.md` has the three new terms, and the new ADR is in `docs/adr/`
