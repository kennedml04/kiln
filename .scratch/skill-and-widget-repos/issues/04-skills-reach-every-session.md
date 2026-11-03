# 04: Skills reach every Session

**What to build:** Every Session, in Claude Code and in OpenCode, gets every skill that is on in the Skills list (ticket 03), and nothing else from outside Kiln. The Session's record says exactly which skills it ran with. Grilled 2026-11-03.

Decisions:

1. **The core decides, the Agent Widget delivers.** When a Session starts, the core works out its skill set (the skills that are on, after list-order clashes) and passes it in `SessionStart` as a list of `{ name, source, commit, folder }`, where `folder` is the read-only checkout from ticket 03. This is a change to the Agent interface in `@kiln/widget-sdk`, so any Agent Widget, including the Pi Widget later, gets skills the same way.
2. **Claude Code.** The Widget hands the skills to the SDK without turning on any setting source: for example as a local plugin the Widget builds per Session in its own data folder, holding links or copies of the skill folders. Sessions keep `settingSources: []`, so the person's `~/.claude/skills`, settings and hooks still don't load. Check the exact SDK option against the pinned SDK version.
3. **OpenCode.** The Widget adds the skill folders to the Session's own OpenCode config (`OPENCODE_CONFIG_CONTENT`), or to a per-Session config folder if OpenCode 1.x only finds skills in a folder. Check against OpenCode 1.19. The person's global OpenCode skills don't load.
4. **The worktree stays clean.** No skill file is written into the Session's worktree.
5. **A Session keeps what it started with.** An update approved while a Session runs applies to Sessions that start after it. A Session that resumes keeps its original skill set.
6. **The record.** The Session's record (and its Digest view) lists each skill it ran with, by name, source and commit.
7. **Policy.** A skill is instructions, not a grant. Commands a skill tells the Agent to run go through the Policy like any other.

**Blocked by:** 03 (Skill repos and the Skills list).

**Status:** ready-for-agent

- [ ] A Session run by the fake Agent receives exactly the skills that are on, with name, source, commit and folder
- [ ] A skill switched off, or shadowed by a higher repo, isn't in the Session's skill set
- [ ] A real Claude Code Session (gated real run) can see and use a skill from a listed repo; a skill in the person's `~/.claude/skills` is not available to it
- [ ] A real OpenCode Session (gated real run, a local model through llama-swap) can see and use a skill from a listed repo
- [ ] No file is added to the worktree
- [ ] A skill update approved mid-Session doesn't change that Session's skills; the next Session gets the update
- [ ] The Session's record lists its skills with source and commit
