# 05: Project skills

**What to build:** A Session also gets the skills that live in its Project's own repo, in `.claude/skills/<name>/SKILL.md` or `.opencode/skills/<name>/SKILL.md`. They are on by default, win over a repo skill with the same name, and can be switched off one by one for that Project. The Org Policy can switch Project skills off everywhere. Grilled 2026-11-03.

Decisions:

1. **Where they come from.** The Session's worktree, at the commit the Session starts on. Both folders are read; when both have a skill with the same name, `.claude/skills` wins.
2. **They win on a clash.** A Project skill is the more specific one, so it replaces a Skill-repo skill of the same name for that Project's Sessions. The Skills list shows the repo skill as "not used in <Project>: the Project has its own".
3. **Per-Project switches.** Each Project skill has an on/off switch in the Project's settings in the Shell. Kiln stores the switch, not the repo, so turning one off needs no commit and doesn't affect anyone using the repo outside Kiln. The switch is remembered by skill name. Turning a Project skill off brings back the repo skill it was shadowing, if there is one.
4. **The Org switch.** The Org Policy gets a setting that turns all Project skills off. When it is set, no Project's skills load, whatever the Project switches say, and the Shell says why.
5. **Who sees what.** Admins flip the switches. Members can see each Project skill's state and why.
6. **Only the skill folders.** The Agent Widget loads the skill folders and nothing else from the repo's `.claude` or `.opencode` folder. Claude Code's `project` setting source stays off, so the repo's `settings.json`, hooks and permissions never load and can't get around the Policy.
7. **Delivery** is the same `SessionStart` skill list as ticket 04, with the source marked as the Project.

**Blocked by:** 04 (skills reach every Session).

**Status:** ready-for-agent

- [ ] A Project with `.claude/skills/<name>/SKILL.md` gives its Sessions that skill
- [ ] A Project skill with the same name as a repo skill replaces it for that Project only, and the Skills list says so
- [ ] Switching a Project skill off removes it from that Project's next Session and brings back the repo skill it shadowed; other Projects are unaffected
- [ ] The Org switch turns all Project skills off, and the Shell shows why
- [ ] A repo's `.claude/settings.json` hook does not run in a Session (a test hook that would write a marker file leaves no marker)
- [ ] A Member can see the switches but gets a refusal changing them
