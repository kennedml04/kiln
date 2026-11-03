# 12: Layered Policy and Permission Asks

**What to build:** Kiln owns one Policy over abstract actions: worktree read, worktree write, known commands, other shell commands, network by domain, external writes (push, PR, issue or comment writes), and anything outside the worktree. Each action is allow, ask or deny. There are three layers: Org (in Kiln's data, edited by Admins), Project (a file in the repo's `.kiln` folder) and Stage (in the Workflow). The effective rule is the strictest across the layers. The Org default allows everything except actions outside the worktree, which are ask. Registering a Project writes a Project Policy template that sets other shell commands, unknown domains and external writes to ask; a local-only Project denies external writes. The effective Policy is handed to the Agent at Session start. When the Agent reports a permission request for an "ask" action, the Session pauses and a blocking Permission Ask is raised with allow once, always allow and deny. "Always allow" is offered only when every layer above the Project allows the action. It writes one narrow rule (that command or domain only) into the Project Policy file, commits only that file, and is audited.

**Blocked by:** 06, 11

**Status:** resolved

- [ ] The effective Policy is the strictest of the Org, Project and Stage layers, for every abstract action
- [ ] A new Project gets the Project Policy template, and local-only Projects deny external writes
- [ ] A permission request for an "ask" action pauses the Session and raises a blocking Permission Ask
- [ ] Allow once lets the step run, deny tells the Session it was refused, and both are audited
- [ ] Always allow writes a narrow rule, commits only the Project Policy file, and is not offered when a higher layer forbids it
- [ ] The Org Policy can be edited only by Admins
