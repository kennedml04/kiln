# Spec: Kiln v1

Status: ready-for-agent

Sources: `GLOSSARY.md`, `docs/adr/0001` to `0010`, `docs/research/runaway-cost-analysis.md`, and a design grill whose notes are not published.

## Problem Statement

The owner runs agent work across many Projects from an earlier home-made board. It has become hard to manage and hard for agents to work on:

- Every feature is wired into one Python server. Each change needs a restart, but agents aren't allowed to restart the board they run inside. That gap produced the restart-when-idle subsystem, the tray, watchdog and recovery processes, and UAC/session-0 failures nobody solved. A crash anywhere takes everything down.
- There are two work models (the card board and the Epic board), each with its own states, kept in sync by hand-written code. Their states drift and the owner can't tell what is really going on.
- Many agents edit one shared checkout. Nobody owns a diff, cards can't close because "the change isn't committed yet", and "done" is a `[[done?]]` marker sniffed out of agent replies.
- Permissions belong to Claude Code, not the board. Unattended work stalls on routine steps (`gh pr create`, killing a python process), the rules are global when the safety concerns are per repo, and the board's own permission broker has an "Always allow" bug.
- The board only knows Claude Code. Some workplaces don't allow Claude Code and use OpenCode instead, so it can't follow its owner there. It also has no users, roles or audit log, so it can't run in a corporate environment.
- One session can run for days with no cumulative cap. One session ran for days and cost hundreds of dollars through subagent fan-out, a 600k-token context, the most expensive model as the default and cache rewrites after idle gaps. No estimate existed and nothing stopped it.
- The real limits differ by place, and the old board measured none of them:
  - A workplace may pay metered credits, with a monthly credit allowance.
  - A home install may use a Claude subscription plan. Its real limit is plan usage (the 5-hour window, the week, and Fable's own weekly allowance), not dollars.
  - A machine may also have free local models.
  - The old board recorded only API-equivalent dollars, which matches neither.
- The UI rebuilds whole pages on every poll, which kills text selection and jumps the scroll.
- Board code and personal hobbies share one tree and one git history, with one user's home folder hard-coded in 19 files. Nobody else can install it.

## Solution

Kiln is rebuilt from scratch in its own repo as a small TypeScript core with everything else as Widgets.

- **The core is three blocks.** The **Shell** is the board UI. **Work** owns Projects, Items, Workflows, Stages, Exits, Gates, Sessions, Threads, Digests, the scheduler and runaway protection. The **Platform** owns identity, roles, audit, Policy, the Widget host and events.
- **One work model, many views.** The all-Projects board and each Project's board show the same Items in the same states, filtered differently.
- **Items move by themselves.** An Item moves forward when Kiln checks that its Stage's Exit is met, or when a person approves a Gate in Needs you. People drag only to set priority.
- **One fresh Session per Stage, one Thread per Item.** Each Session is seeded with the Item's artifacts and Digests, never a raw transcript.
- **Every Ticket gets its own git worktree and branch.** Kiln checks the Exit itself (commits, clean tree, tests pass) and merges, or opens a PR, when the Review Gate is approved.
- **Kiln owns one layered Policy over abstract actions.** Each Agent Widget translates it into its tool's own settings. Permission requests become blocking Asks, and "always allow" writes a narrow, audited rule into the Project's Policy.
- **Runaway protection is on by default and measured against Budgets.** Each install sets up its own Budgets:
  - **Metered:** credits or dollars, for work.
  - **Subscription:** plan quota windows, tracked as percent used and time to reset, with Fable as its own gauge, for home.
  - **Local:** local models, capped by turns and time.

  Every Session draws on the Budget its model belongs to. Protection includes cumulative per-Session caps (subagents included), period limits, pacing against the week, a reserve kept for the person's own use, stall detection, a context alarm, an always-visible Stop all and live usage on every running Item. Hitting a limit pauses the work and raises an Ask; it never kills the work.
- **Widgets are separate processes with Manifests.** They are installed from the public repo or a private Widget source, pinned in a lockfile, approved by a person and started, stopped or updated without restarting the core. v1 ships the Claude Code and OpenCode Agent Widgets, a GitHub Issues Tracker Widget, a GPU monitor panel and the TypeScript Widget SDK.
- **Kiln runs alongside the old board.** It lives on port 8300 with data in `%LOCALAPPDATA%\Kiln` and shares nothing with the old board on 8195. Cutover happens after Kiln has run the owner's real daily flow for a week.

## User Stories

### Setup and running Kiln

1. As the owner, I want a setup wizard on first run, so that I can pick the login mode, Knowledge store, Budgets and Agents without editing files.
2. As the owner, I want setup to offer default Budgets for the kind of install (metered credits at work, a subscription plus local models at home) with limits I can accept or change, so that runaway protection is on from the first Session.
3. As the owner, I want setup to suggest installing Obsidian when it isn't installed, without requiring it, so that the markdown Knowledge store is pleasant to browse but nothing depends on it.
4. As the owner, I want setup to import the Projects registered on the old board in one step, so that I don't have to re-register them by hand.
5. As the owner, I want that import to only read the old board's data, so that the old board keeps running untouched.
6. As the owner, I want my existing `.scratch` markdown Stories, Epics and Tickets to show up as Items with no conversion, so that the work in flight carries over.
7. As the owner, I want Kiln to start when I log in as one process with no tray, watchdog or recovery helpers, so that there is only one thing to keep running.
8. As the owner, I want `kiln start`, `kiln stop` and `kiln status`, so that I can control Kiln from a terminal.
9. As the owner, I want `kiln doctor` to check the port, data folder, Widget health, git, the Agents and the Knowledge store and tell me what's wrong in plain words, so that I can fix setup problems without reading logs.
10. As the owner, I want Kiln on port 8300 with its data in `%LOCALAPPDATA%\Kiln`, so that it never collides with the old board on 8195.
11. As the owner, I want the name "Kiln" everywhere (packages, headers, data, UI), so that old names like gpuboard, X-GPUBoard and Model Monitor don't carry over.
12. As the owner, I want the port and data folder to be settable, so that dev instances and tests can run beside the live Kiln.

### Projects, Items and Workflows

13. As the owner, I want to register a Project by pointing Kiln at a repository, so that Kiln can track and run its Items.
14. As the owner, I want each Project to pick a Workflow, with the default Workflow used when it names none, so that a new Project works without configuration.
15. As the owner, I want the default Workflow's Epic, Story and Ticket kinds with their Stages (Epic: Roadmap → Shipped; Story: Grill → Spec [Gate] → Tickets [Gate] → Shipped; Ticket: Implementing → Review [Gate] → Shipped), so that my current flow works on day one.
16. As a corporate team lead, I want to define my own Item kinds, Stages, Gates and agent roles in a Project's Workflow, so that Kiln fits our process rather than the default one.
17. As the owner, I want the Workflow and the Project Policy to live as files in the Project's repo, so that they are versioned and reviewed with the code.
18. As the owner, I want each Stage in the Workflow to name its agent role, its Agent and its model, so that the expensive model is never the silent default.
19. As the owner, I want Items to have parents and children, so that Epics group Stories and Stories group Tickets.
20. As the owner, I want an Epic to ship by itself once all its Stories have shipped, so that I never close Epics by hand.
21. As the owner, I want a Story to ship by itself once all its Tickets have shipped, so that the roll-up stays correct.
22. As the owner, I want to create an Item from the Shell (title, kind, parent, short description), so that I can add work without opening the repo.
23. As the owner, I want an Item to move to the next Stage as soon as its Exit is met, so that work flows without me dragging cards.
24. As the owner, I want Kiln to refuse drag-to-move between Stages, so that the only way past a Gate is approving it.
25. As the owner, I want to drag Items to set their priority in Up next, so that I control what runs first.
26. As the owner, I want to see why an Item hasn't moved (which part of the Exit is missing), so that I know whether to wait or step in.

### Sessions, Threads and Digests

27. As the owner, I want Kiln to start a fresh Session when an Item enters an agent Stage, seeded with the Item's artifacts and Digests, so that Sessions stay small and cheap.
28. As the owner, I want one Thread per Item that shows every Session across all its Stages in order, so that I follow one conversation, not many.
29. As the owner, I want to type into an Item's Thread and have it reach that Item's current Session (or start a fresh one if none is running), so that I talk to the Item, not to a particular Agent.
30. As the owner, I want a Project Thread that can read everything in the Project and propose changes as Asks but never make them, so that I get a planning partner without a "PM agent" changing things behind my back.
31. As the owner, I want every Session to write a Digest when it ends (Stage exit, Gate answered, chat gone idle), so that the next Session starts from what was decided.
32. As the owner, I want Digests rolled up once they pile up, so that seeding stays short on long-lived Items.
33. As the owner, I want Digests stored in the Knowledge store as plain markdown with frontmatter, so that I can read them in Obsidian.
34. As the owner, I want a Thread to keep streaming while I select text or scroll, so that the UI never yanks me back to the top.
35. As the owner, I want a Session that comes back after its prompt cache has expired to restart fresh from Digests, so that I don't pay to re-read a huge context.

### Worktrees, Exits and Gates

36. As the owner, I want every Ticket that enters Implementing to get its own worktree and branch, so that Agents never share uncommitted work.
37. As the owner, I want Kiln to check the Implementing Exit itself (the branch has commits, the working tree is clean, the Project's tests pass), so that "done" is never a claim parsed out of a reply.
38. As the owner, I want the Project's test command named in the Project's Kiln files, so that Kiln knows how to check the Exit.
39. As the owner, I want a failing Exit check to go back to the Session as feedback rather than moving the Ticket, so that the Agent can fix it.
40. As the owner, I want the Review Stage to run a review Session that writes its findings, then raise a Review Ask for me, so that I approve with the findings in front of me.
41. As the owner, I want approving the Review Gate to merge the branch (or open a PR if the Project uses PRs) and remove the worktree, so that shipping is one click.
42. As the owner, I want a merge conflict to raise a blocking Decision Ask with a recommended fix, so that conflicts surface at merge time with a clear next step.
43. As the owner, I want rejecting a Gate (with a comment) to send the Item back to the Stage's Session with my comment, so that rework is one step.
44. As the owner, I want the Spec and Tickets Gates on Stories to show the spec and the Ticket list in the Ask, so that I can approve without hunting for files.
45. As the owner, I want Story Stages that write to the repo to work in their own worktree, merged when their Exit or Gate passes, so that no Session ever edits the main checkout.

### Asks and Needs you

46. As the owner, I want every Ask to be typed (Decision, Permission, Review or Question), name its Item, say why it matters and carry a recommended answer, so that I can answer quickly.
47. As the owner, I want one Needs you inbox holding every open Ask from every Project, sorted by how much work each one blocks, so that I answer the most important first.
48. As the owner, I want non-blocking Asks to let the Session carry on with its recommendation, so that small choices never stall work.
49. As the owner, I want Permission Asks and Gates to always block, so that nothing risky or unapproved happens on a guess.
50. As the owner, I want answering an Ask to resume or update the Session that raised it, so that I don't have to restart anything.
51. As the owner, I want to change my answer to a non-blocking Ask while the Session is still running, so that I can correct a recommendation I disagree with.
52. As a Widget, I want to raise Asks on an Item through the core, so that my questions land in the same Needs you inbox.

### Policy and permissions

53. As the owner, I want Sessions governed by one Kiln Policy over abstract actions (read or write inside the worktree, the Project's known commands, other shell commands, network by domain, external writes, anything outside the worktree), so that the same rules apply whichever Agent runs.
54. As a corporate admin, I want an Org Policy that Projects and Stages can only tighten, never loosen, so that my baseline holds everywhere.
55. As the owner, I want a Project Policy file in each repo, so that a local-only repo can deny pushes and PRs while another allows them.
56. As the owner, I want Stages to tighten Policy (for example, Grill and Spec can't push), so that each role gets only what it needs.
57. As the owner, I want an action set to "ask" to pause the Session and raise a Permission Ask with allow once, always allow and deny, so that I decide unusual steps.
58. As the owner, I want "always allow" to write one narrow, audited rule into the Project Policy, so that a routine step never stalls work again and the rule is visible in the repo.
59. As the owner, I want "always allow" offered only when the layers above permit it, so that I can't loosen the Org Policy by accident.
60. As the owner, I want broad file rights inside a Ticket's worktree by default, so that unattended work doesn't stall on edits that can't affect anything else.
61. As the owner, I want the Project Thread's Sessions to be read-only by Policy, so that "propose, never make" is enforced, not just promised.

### Budgets, runaway protection and usage

62. As the owner, I want each Kiln install to set up its own Budgets, so that work and home have different limits.
63. On a work install, I want a metered Budget in credits (default 10,000 a month, stored with its rate of 50 credits per dollar), so that Kiln shows and caps spend in the unit the organisation bills in.
64. On a home install, I want a subscription Budget for a Claude subscription plan that tracks each usage window (the 5-hour window and the week) as percent used and time until reset, so that caps match the limit I actually hit, not dollars I don't pay.
65. As the owner, I want Fable's weekly allowance tracked as its own gauge in the subscription Budget, so that I can save Fable for the Stages where it matters most.
66. As the owner, I want to see weekly usage next to how much of the week has passed (pace) and the time left until reset, so that I know whether I can afford more unattended work this week.
67. As the owner, I want Kiln to stop starting new unattended Sessions on a subscription Budget while it is ahead of pace, and raise an Ask, so that agents don't use up the week before I do.
68. As the owner, I want a reserve on each subscription window (default 10%) that unattended work never touches, so that I can still use Claude myself when Kiln has been busy.
69. As the owner, I want work paused on the 5-hour window to resume by itself when the window resets (whenever the plan reports that window), so that a short-window limit doesn't need me.
70. As the owner, I want a Stage that names Fable to raise an Ask recommending a fallback model when Fable's allowance reaches its reserve, so that work moves to another model only if I agree.
71. As the owner, I want Fable usage per Stage, per Item kind and per Project shown over the week, so that I can see where Fable is going and move it to where it pays off.
72. On a home install, I want a local Budget for local models that has no money cap but is capped by turns and wall time and uses the gpu pool, so that free local work isn't blocked by dollar caps and still can't loop forever.
73. As the owner, I want a local Budget to work on any machine with a local model server (such as a laptop), so that local work isn't tied to one PC.
74. As the owner, I want every model a Workflow can name to belong to exactly one Budget, so that Kiln knows what each Session draws from.
75. As the owner, I want a hard cap per Session in its Budget's unit (credits, share of the week, or turns and time), counting every subagent the Session spawns, so that one Session can't run away for days the way one did on the old board.
76. As the owner, I want a cap per Project per day on metered Budgets, so that one Project can't spend the month.
77. As the owner, I want hitting a cap to pause the work and raise a blocking Ask, so that nothing is lost and I choose whether to raise the limit.
78. As the owner, I want reaching a Budget's period limit (the monthly credits, or a window's reserve) to pause everything drawing from that Budget and nothing else, so that home work on local models keeps going when the plan's week is spent.
79. As the owner, I want a warning on the Item when a Session passes half its cap, so that I can step in early.
80. As the owner, I want stall detection (several turns with no new commits and no artifact changes, or the same tool call repeated) to pause the Session and raise an Ask, so that loops don't burn money or quota.
81. As the owner, I want a context alarm that pauses a Session past a threshold, writes a Digest and carries on as a fresh Session, so that context never grows to 600k tokens.
82. As the owner, I want an always-visible Stop all button (with a confirmation) that pauses every Session and the scheduler, so that I can halt everything in one move.
83. As the owner, I want live usage on every running Item in its Budget's unit (credits, quota percent, or turns and time) plus tokens and context size, and the Budget gauges in the Shell header, so that I can see spend as it happens.
84. As the owner, I want Kiln to record actual usage per turn (model, Budget, context size, cache reads, cache writes, output tokens, cost in the Budget's unit, API-equivalent dollars, idle gap before the turn), so that later estimates and routing rest on measured data.
85. As the owner, I want the plan's quota readings recorded at the start and end of every Session on a subscription Budget, so that I can see what each Session cost in quota.
86. As the owner, I want subagent usage recorded with its description and rolled up to its Session, Item, Epic and Project, so that fan-out cost is visible.
87. As the owner, I want usage counted from a Session's first turn, so that cost is never undercounted when work adopts an existing thread.
88. As the owner, I want Kiln never to show an estimate in v1, so that I'm not misled by guesses (estimation and routing are a later Widget built on these records).

### Scheduler

89. As the owner, I want queued Sessions to wait for room in a named capacity pool (default "agents: 3"), so that my machine isn't overloaded.
90. As a Widget author, I want to declare my own pool (for example "gpu: 1") in my Manifest, so that GPU-bound work is serialized.
91. As the owner, I want the queue ordered by the priority I set in Up next, so that the most important work starts first.
92. As the owner, I want to change a pool's size from the Shell, so that I can allow more parallel work when I'm watching.

### Shell

93. As the owner, I want an all-Projects board as home, so that I see all running, waiting and queued work at a glance.
94. As the owner, I want a per-Project board whose columns are that Project's Stages, so that I can see where each Item is in its Workflow.
95. As the owner, I want both boards to update live through server-pushed events, patching only what changed, so that the UI is fast and never flickers.
96. As the owner, I want Needs you visible from every page with its count, so that I never miss a blocking Ask.
97. As the owner, I want Widget panels to appear in the Shell where their Manifest says, so that features show up without core changes.
98. As the owner, I want the Shell usable from my phone over Tailscale, so that I can answer Asks away from the PC.

### Identity, roles and audit

99. On a home install, I want Local mode (localhost only, the person at the PC is Admin, no login), so that the homelab setup needs no configuration.
100. As the owner, I want Tailscale identity for remote access, so that people on my tailnet are known by their Tailscale login without passwords.
101. As an Admin, I want to give each user a role (Admin, Member or Viewer), so that a Viewer can watch without changing anything.
102. As a Member, I want to start work, chat in Threads, answer Asks and approve Gates, so that I can do the daily work without admin rights.
103. As an Admin, I want only Admins to install Widgets, edit the Org Policy, change caps and manage users, so that the risky settings are protected.
104. As a corporate admin, I want an always-on audit log of every change made by users, Sessions (as their Agent) and Widgets, so that I can answer "who did this?".
105. As an Admin, I want to view and filter the audit log in the Shell, so that I don't have to query the database.

### Widgets

106. As the owner, I want to install a Widget from the public repo or from a private Widget source (a local folder or private git repo), so that my private Widgets never touch a public remote.
107. As the owner, I want every install pinned to an exact tag or commit in a lockfile, so that an install is reproducible and nothing updates under me.
108. As the owner, I want to see a Widget's Manifest (what it provides and needs: data, Asks, network, secrets, pools) and approve it at install, so that I know what I'm granting.
109. As the owner, I want an update that asks for more than before to need fresh approval, so that a Widget can't quietly widen its rights.
110. As a corporate admin, I want the Org Policy to restrict which Widget sources are allowed, so that only vetted Widgets are installed.
111. As the owner, I want Widgets started, stopped, updated and removed without restarting the core, so that changing a Widget never interrupts running Sessions.
112. As the owner, I want a crashing Widget restarted with backoff and shown as unhealthy, without taking the core down, so that one bad Widget doesn't break Kiln.
113. As a Widget, I want to call the core only through one local API with my own credential, and have anything outside my Manifest refused, so that the boundary is real.
114. As a Widget author, I want to describe a panel declaratively and let the Shell draw it, so that simple Widgets need no frontend code.
115. As a Widget author, I want a sandboxed embedded page for rich UI, so that I can build complex views without access to the Shell or other Widgets.
116. As a Widget author, I want to publish and subscribe to core events, so that my Widget reacts to Item and Session changes.
117. As a Widget author, I want my own data folder and secrets held by the Platform, so that I don't invent my own storage or keep tokens in plain files.
118. As a Widget author, I want a TypeScript Widget SDK with typed Manifest, API client, panel helpers, the Agent and Tracker interfaces, and a test harness, so that the compiler checks my Widget against the contract.

### Agent Widgets

119. As the owner, I want a Claude Code Agent Widget, so that Kiln runs Sessions with Claude Code at home.
120. As the owner, I want an OpenCode Agent Widget, so that Kiln runs Sessions with OpenCode at work.
121. As the owner, I want both Agents to behave the same through one Agent interface, so that a Workflow can switch Agent per Stage without other changes.
122. As an Agent Widget, I want to translate Kiln's Policy into my tool's own permission settings and turn its permission prompts into Kiln permission requests, so that the Policy holds whatever tool runs.
123. As an Agent Widget, I want to report usage per turn, including subagents, so that caps and records stay accurate.
124. As a Session, I want Kiln tools to raise an Ask, read my Item and its artifacts, write my Item's content and write my Digest, so that I work through Kiln rather than through text markers.

### Trackers and the Knowledge store

125. As the owner, I want the default Tracker to be markdown in the Project's repo, so that Item records are plain, versioned files.
126. As a corporate user, I want a GitHub Issues Tracker Widget, so that a team's Items live in GitHub Issues.
127. As the owner, I want Kiln to write only the Stage and Status fields while Agents write the content, so that ownership of each field is clear.
128. As the owner, I want anything a person needs to read or share (Items, Digests, decisions) to live in the Tracker or the Knowledge store, so that losing Kiln's SQLite file never loses work.
129. As the owner, I want the Knowledge store chosen at setup, defaulting to a markdown folder, so that I can point it at my existing vault or a new folder.

### GPU monitor Widget

130. As the owner, I want a GPU monitor panel showing each GPU's use, VRAM and the processes holding it, so that I know what is using the card before GPU work starts.
131. As the owner, I want the GPU monitor to declare a "gpu: 1" pool, so that GPU work never runs two at a time.

### Developing Kiln with Kiln

132. As an agent working on a Kiln core Ticket, I want to start a dev instance from my worktree with its own port and a throwaway data folder, so that I test my change without touching the live Kiln.
133. As the owner, I want Agents never to restart the live core, and core updates applied only when I choose "Restart when idle", so that running work is never cut off.
134. As an agent working on Kiln, I want tests that never touch the live Kiln, the old board or their data, so that a test run can't break real work.

## Implementation Decisions

### Shape and stack

- **One public monorepo (ADR 0008)** holds the core, the first-party Widgets and the TypeScript Widget SDK, so they share one version history and one CI. Private Widgets live in separate Widget sources.
- **TypeScript end to end (ADR 0009).** The core is a Node server, the Shell is React, and the core API, the Widget SDK and the Shell share one set of types.
- **One core process (ADR 0010).** It starts at user login as a per-user startup entry. Docker is deferred. The core supervises its Widgets itself; there is no tray, watchdog or recovery process.
- **Runtime state lives in one SQLite file in the data folder (ADR 0005).** It holds Sessions, open Asks, the audit log, events, usage records, the scheduler queue, users and roles, Widget registrations and grants. Item content and Stage never live only there.

### Core modules

These are deep modules with small interfaces. Each is reached through the core API.

- **Work model.** Projects, Items (kind, parent, children, Stage, run state, priority), Workflows and Item kinds. It loads a Project's Workflow and answers "what is this Item's next Stage and what is its Exit?".
- **Workflow loader.** Reads the Project's Workflow file and validates it. A Workflow lists Item kinds, each kind's ordered Stages and, for each Stage: its agent role, its Agent, its model, an optional fallback model (offered when the model's Budget runs low), its Exit check, whether it is a Gate, whether it needs a worktree, its Stage Policy and which capacity pool it uses. The default Workflow ships in the core and applies when a Project has none.
- **Exit checker.** Exits are named checks from a fixed set the Workflow can combine. "Artifact exists for this Item", "branch has commits", "working tree clean", "Project tests pass", "all children shipped" and "no open blocking Asks" cover the default Workflow. The checker runs when a Session finishes or reports progress. A failing check goes back to the Session as feedback, and a passing one moves the Item (or raises the Gate's Review Ask).
- **Default Workflow Exits:**
  - Grill: the grill record exists.
  - Spec: the spec exists, then the Gate.
  - Tickets: at least one Ticket child exists, then the Gate.
  - Implementing: commits, a clean tree and passing tests.
  - Review: the review findings exist, then the Gate.
  - Epic and Story move to Shipped when all their children have shipped.
- **Worktree manager.** Creates a worktree and branch per Item Stage-run that needs one (every Ticket in Implementing, and Story Stages that write to the repo). It merges on Gate approval, or on Exit for Stages without a Gate. In PR mode it pushes and opens a PR instead. It removes the worktree afterwards. A conflict raises a blocking Decision Ask. No Session ever writes to the Project's main checkout.
- **Session manager.** Starts a fresh Session per Stage through the Agent interface, seeded with the Item's artifacts and its Digests (or their rollup). It routes Thread messages to the current Session and handles pause and resume. A resume after the Agent's reported cache lifetime has passed starts fresh from Digests. It asks the Agent to write a Digest whenever a Session ends.
- **Thread.** The ordered record of an Item's or Project's Sessions and messages. It is rendered from runtime state plus Digests. Project Thread Sessions always run under a read-only Stage Policy and can only raise Asks.
- **Ask service.** Creates, answers and resolves Asks of type Decision, Permission, Review or Question. Each Ask carries its Item, why it matters, a recommended answer and whether it blocks. Permission Asks and Gates always block. Needs you sorts open Asks by how much work they block: the number of Items and Sessions waiting on the Ask, directly or through children, with ties broken by age. An answer is delivered to the raising Session or Widget, and to the Exit checker for Gates.
- **Scheduler.** Keeps named capacity pools (default "agents: 3"; Widgets add pools through their Manifest) and a queue of Sessions waiting for room. The queue is ordered by Item priority, then by age. Stop all pauses every running Session and halts dispatch until a person resumes it.
- **Budgets.** A Budget is what a Session's usage draws from. Each install sets up its own Budgets (work and home differ), and each model a Workflow can name belongs to exactly one Budget through its Agent. There are three kinds:
  - **Metered:** money or credits, with a unit label and a rate to USD (the example default is 50 credits per dollar). Limits: per Session, per Project per day, and per month.
  - **Subscription:** a plan with usage windows, each with a percent used and a reset time. For Claude Max these are the 5-hour window, the week, and Fable's own weekly allowance. The Agent Widget reports the readings. Limits: a per-Session share of the weekly window, a pace rule and a reserve per window.
  - **Local:** models served on this machine through an OpenAI-compatible endpoint, run through the OpenCode Agent Widget. There is no money involved. Limits are turns and wall time per Session, and Sessions take a slot in the gpu pool. Nothing in a local Budget is tied to Windows or NVIDIA, so the same Budget works on an Apple Silicon laptop.
- **Usage and runaway guard.**
  - **Records.** It takes per-turn usage reports from Agent Widgets and stores one record per turn: Session, parent Session (for subagents), subagent description, model, Budget, context size, cache reads, cache writes, output tokens, cost in the Budget's unit, API-equivalent USD (for comparison across Budgets later), and the idle gap before the turn.
  - **Quota readings.** For subscription Budgets it also stores every reading the Agent reports (window, percent used, reset time), always at the start and end of each Session.
  - **Attribution.** A Session's quota cost is the change in readings across its turns. When several Sessions run at once on the same Budget, the change is split in proportion to their tokens. This is attribution of measured numbers, not estimation. Readings cover the whole account, including the person's own use outside Kiln in the same minutes. Per-Session quota costs are therefore labelled approximate. The pace rule and reserves compare against the account-wide readings directly, which is what protects the person's own share.
  - **Usage credits.** When a plan has paid usage credits turned on, Claude Code can keep working past a used-up window by spending them. Kiln treats any sign of that (the Agent reporting overage in use, or the plan's used credits rising during a Session) as reaching the window's limit: it pauses the work and raises a blocking Ask rather than spending credits unattended.
  - **Roll-ups and enforcement.** Records roll up to Session, Item, Epic, Project, Stage, Item kind, day, week and month. It enforces the Budget limits, the stall rule and the context alarm. Breaching a cap pauses the work and raises a blocking Ask. The context alarm instead pauses, has the Session write a Digest and continues as a fresh Session, without an Ask. A Budget's period limit pauses only work drawing from that Budget. The core never estimates.
- **Default limits** (example defaults setup offers for the Budgets it creates, and an Admin can change them later):
  - **Metered (work install):**
    - Monthly: 10,000 credits.
    - Per Session: 500 credits or 150 turns, whichever comes first, counting subagents.
    - Per Project per day: 1,250 credits.
  - **Subscription (home install, Claude Max):**
    - Per Session: 5% of the weekly window or 150 turns, counting subagents.
    - Pace rule: when weekly percent used is more than 10 points ahead of the share of the week elapsed, no new unattended Session starts on this Budget. A blocking Decision Ask is raised with "hold until back on pace" as the recommendation. Running Sessions continue to their own caps, and Thread messages the person sends are always allowed.
    - Reserve: 10% of each window (5-hour, weekly, Fable weekly) is kept for the person's own use.
    - At the 5-hour reserve, work drawing from it pauses with a non-blocking Ask (recommendation: wait) and resumes by itself after the reset. Sessions whose cache has expired resume fresh from Digests.
    - At the weekly reserve, everything on the Budget pauses with a blocking Ask.
    - At the Fable reserve, Sessions on Fable pause and each affected Stage raises a blocking Decision Ask recommending the Workflow's fallback model for that Stage.
  - **Local (home install):** per Session 300 turns or 2 hours.
  - **All kinds:**
    - Warning at 50% of any cap.
    - Stall: 8 consecutive turns with no new commit and no artifact change, or the same tool call with the same arguments 3 times in a row.
    - Context alarm: the lower of 300k tokens and 60% of the model's context window.
- **No readings.** "Unknown" applies per window, not per Budget. A window with no reading shows "unknown", and its pace, reserve and auto-resume rules don't apply while it is unknown. The Claude Max account checked in research reported the weekly and Fable windows but no 5-hour reading, so the 5-hour rules may stay dormant. If every window is unknown, only the turn caps, stall rule and context alarm apply. `kiln doctor` warns about each unknown window.
- **Policy engine (ADR 0006).** The abstract actions are: worktree read, worktree write, known commands, other shell commands, network (by domain), external writes (push, PR, issue or comment writes) and outside the worktree. Each one is set to allow, ask or deny.
  - Layers: Org (held in Kiln's data, edited by Admins), then Project (a file in the repo), then Stage (in the Workflow). The effective rule is the strictest across the layers (deny beats ask beats allow).
  - Defaults: the Org default allows everything except outside the worktree, which is ask. The Project Policy template written at Project registration sets other shell commands, unknown domains and external writes to ask. A Project marked local-only denies external writes.
  - "Always allow" is offered only when every layer above the Project allows the action. It writes one narrow rule (that command or domain only) into the Project Policy file and commits only that file in a Kiln-authored commit. It is audited.
- **Tracker interface.** List, read and watch Items. Write the Stage and Status fields. Read and write Item content (for Sessions through the Kiln tools). Create child Items.
  - The markdown Tracker reads the existing `.scratch` layout as-is: Story folders with story, spec and numbered Ticket files, and Epics in their own folder. It writes Stage and Status lines as small Kiln-authored commits on the default branch that touch only those lines. For an Item with a live worktree, it also reads in-flight artifacts from that worktree.
- **Knowledge store interface.** Write and read Digests, decisions, retros and notes. The default store is a markdown folder with frontmatter, readable as an Obsidian vault. Other backends are Widgets.
- **Event bus.** Every state change becomes a typed event in SQLite. Widgets subscribe through the Widget API and the Shell over SSE. Events are named in the domain's terms (Item moved Stage, Session started or paused or finished, Ask raised or answered, usage updated, Widget health changed).
- **Identity and audit.** Login adapters: Local mode (binds to localhost only; the local person is Admin) and Tailscale (binds to localhost and the Tailscale interface; the connecting peer's identity comes from the local Tailscale daemon). Unknown tailnet users get no access until an Admin gives them a role. Roles are Admin, Member and Viewer. Every mutating request is checked against the role and written to the append-only audit log, with the actor (a user, a Session or its Agent, a Widget, or Kiln itself). Mutating requests from the browser need a CSRF token.

### Widget contract

- **Process model (ADR 0007).** Each Widget is its own process in any language. The core starts it with the core API's address and a per-Widget credential. The Widget registers, declares readiness and receives events. It talks to the core only through the local Widget API. Requests outside its approved grants are refused and audited. The core restarts a crashed Widget with backoff and marks it unhealthy after repeated failures.
- **Manifest fields:**
  - Identity: id, name, version, source.
  - Supported core API version range.
  - The command that starts it.
  - What it provides: panels, Agents, Trackers, Knowledge store backends, capacity pools and named actions.
  - What it needs: which Work data it reads or writes (by Project scope), whether it raises Asks, network domains, named secrets, and its own data folder.
  - The Platform grants only what the Manifest declares and an Admin approved. An update that adds needs requires fresh approval.
- **Install flow:** choose a source (the public repo or a private local folder or git repo the Org Policy allows), resolve an exact tag or commit, write it to the lockfile, show the Manifest, get Admin approval, then install, start and register, all without a core restart.
- **Panels:** the Widget API lets a Widget publish a declarative panel description (cards, tables, stats, buttons bound to its named actions) that the Shell draws and patches when it changes. Rich Widgets declare an embedded page instead. The Shell loads it sandboxed, with no access to the Shell's origin, cookies or other Widgets, and it talks to its own Widget only through a message bridge.
- **Secrets:** held by the Platform in the OS credential store, never in SQLite or plain files, and handed only to the Widget that declared them.
- **Versioning:** the core API is versioned. A Widget whose supported range excludes the running core is not started and is shown as incompatible.

### Agent interface (ADR 0004)

- **Start a Session:** its role, its model, the seed (artifacts and Digests), its worktree (or none), the effective Policy and the Kiln tools endpoint for this Session.
- **Send a message** into a running Session (Thread messages and Ask answers).
- **Interrupt:** pause after the current step and stay resumable.
- **Resume** and **stop.**
- **Events from the Agent:** progress, permission request (the abstract action plus the concrete detail), usage per turn (including subagent turns with their description), quota reading (for subscription plans that expose them: the window, the model it is scoped to if any, percent used on a 0-100 scale, reset time as an ISO 8601 time, when the reading was taken, its source, and whether paid overage is in use), Digest written, and finished (with its reason).
- The Agent also reports its prompt-cache lifetime for the model in use, so the Session manager can decide between resuming and starting fresh.
- **Kiln tools** are offered to every Session over MCP (Claude Code and OpenCode both speak it): raise an Ask, read this Item and its artifacts, write this Item's content, create child Items (in the Tickets Stage), and write the Digest. They are scoped to the Session's own Item, or to the Project read-only for Project Thread Sessions.
- **The Claude Code Agent Widget** wraps the Claude Agent SDK. It maps the Policy to Claude Code permission settings and handles prompts through a permission callback that becomes a Kiln permission request. It reads usage and subagent costs from the SDK's results. It reports the Claude Max quota readings as `docs/research/claude-code-quota-readings.md` describes. It polls the SDK's usage method, which costs no model usage, at a modest interval and always at the start and end of each Session. Rate-limit events alone aren't enough, because they fire only on change and never cover Fable. That method is marked experimental by Anthropic. If it disappears, the weekly window falls back to rate-limit events and Fable becomes unknown. The Widget normalises units (events use 0-1 and epoch seconds), and `kiln doctor` checks that readings are available.
- **The OpenCode Agent Widget** wraps OpenCode's SDK and maps the Policy to OpenCode's permission configuration in the same way. It serves two Budgets: the metered work Budget, and local Budgets by pointing OpenCode at a local OpenAI-compatible model server.
- Neither Agent's hooks, session IDs or settings files leak into the core.

### Project files

- A Project keeps its Kiln files in a `.kiln` folder at the repo root: the Workflow (optional; the default applies if it's missing), the Project Policy, and Project settings (test command, known commands, local-only flag, merge or PR mode, Tracker choice).

### Shell

- **Home** is the all-Projects board, grouped by run state (Backlog, Up next, Running, Waiting, Shipped recently), with priority set by dragging within Up next.
- **Project view:** columns are that Project's Stages, one row group per Item kind.
- **Item view:** its Thread, artifacts, Exit status, worktree and branch, and live usage.
- **Project Thread view.**
- **Needs you:** a global badge and an inbox page.
- **Widgets page:** sources, installs, Manifests, health and approval.
- **Settings:** Budgets and their limits, which model belongs to which Budget, pools, Org Policy, users and roles, Knowledge store, login mode.
- **Budget gauges** sit in the persistent header:
  - metered: used this month against the limit
  - subscription: weekly percent used against pace, time to reset, the 5-hour window and Fable's gauge
  - local: running Sessions
- **Budget page:** usage over the period by Project, Stage and Item kind, with Fable broken out.
- **Audit log page.**
- **Stop all** is in the persistent header with a confirmation.
- One SSE stream per browser feeds a client-side store, and components re-render only the parts whose data changed. Thread rendering keeps text selection and scroll position intact.

### Setup, CLI and import

- **Setup wizard (first run, re-runnable by Admins):** login mode, Knowledge store folder (it checks for Obsidian and suggests it if missing), Budgets, installing the first-party Agent Widgets, and the model (and fallback) per role for the default Workflow (no silent expensive default), then the Project import. For Budgets, setup asks whether this is a work or home install and offers the matching defaults: a work install gets a metered credits Budget; a home install gets a Claude Max subscription Budget plus a local Budget if it finds a local model server. Then it asks which models belong to each Budget.
- **`kiln` CLI:**
  - `start`, `stop`, `status` and `doctor`.
  - A dev-instance command that starts a core from a given worktree on a free port with a throwaway data folder.
  - Restart when idle: waits for no running Sessions, then restarts the core.
- **Project import:** reads the old board's Project registry read-only and registers each Project with the markdown Tracker. It never writes to the old board's folder or data.

### GPU monitor Widget

- **A declarative panel only:** it shows each GPU's use, VRAM and the processes holding it, read through the vendor tools.
- It declares the "gpu: 1" pool.
- It is the ported Widget that proves the contract end to end.

### GitHub Issues Tracker Widget

- **Maps Items to issues:**
  - Item kind and Stage become labels.
  - Parent and child become sub-issues.
  - Status becomes open or closed plus a label.
- It also provides the push-and-PR capability (and detects merged PRs) used by PR-mode Projects.
- It declares the network domain for GitHub's API and a named token secret.

## Testing Decisions

- **A good test drives Kiln from outside**, the way the Shell, a Widget or a person would, and checks only what can be seen there: API responses, SSE events, files in the Project repo, the Knowledge store, git state. It never asserts on internal modules, tables or call order, so the internals can be rebuilt freely.
- **Seam 1, the main one: the core API.**
  - Each test starts a real core process on a free port with a throwaway data folder. It registers a temp git repo as the Project and installs a scripted fake Agent Widget built on the TypeScript Widget SDK.
  - The fake Agent follows a script: make these edits, commit, request this permission, report this usage or quota reading, loop on this tool call, raise this Ask.
  - A test instance's clock can be set through a test-only control on that instance, never on a live core, so pace, window resets and day, week and month roll-overs are tested without waiting.
  - Through the API and the event stream, the tests cover Workflows and Exits, Gates, worktrees and merge, Asks and Needs you ordering, Policy layering and "always allow", the scheduler and pools, caps, stall and context alarms, Stop all, Digests and seeding, roles and audit, Budgets (metered credit caps; subscription pace, reserves, 5-hour auto-resume and the Fable fallback Ask; local turn and time caps; "unknown" when no readings arrive), the Widget host (install, approval, refusal outside the Manifest, crash and restart without a core restart), the markdown Tracker and the markdown Knowledge store.
- **Seam 2: contract suites at the same boundary.**
  - The Agent contract suite runs against the fake Agent, the Claude Code Widget and the OpenCode Widget. It covers start, message, interrupt, resume, stop, Policy translation, permission requests, per-turn and subagent usage, Kiln tools and Digests.
  - The runs against real Agents are opt-in (not in default CI). They use the cheapest model, a tiny scripted task and a hard cap of a few cents.
  - The Tracker contract suite runs against the markdown Tracker and the GitHub Issues Widget. The GitHub run is opt-in, against a throwaway repo.
- **Seam 3: a thin layer of browser end-to-end tests of the Shell** on top of seam 1:
  - home board and Project view
  - answering an Ask in Needs you
  - approving a Gate
  - Stop all
  - a declarative Widget panel
  - live Thread streaming keeping selection and scroll
- **Isolation rule:** no test may touch the live Kiln (8300, `%LOCALAPPDATA%\Kiln`), the old board (8195) or their data. Every test gets its own port, data folder and temp repo. The same rule covered the old board's tests (its fake-pueue fixture in `gpuboard\tests\conftest.py`), and test leaks into live config were a recorded pain there.
- **Prior art:** none in this repo; nothing is built yet. The first Ticket sets up the seam-1 harness (start core, temp repo, fake Agent) so every later Ticket writes tests against it.
- Tests and the permission allowlist are set up from day one.

## Out of Scope

- OIDC/SSO login, Jira Tracker, Docker packaging.
- The standups/status Widget, the estimation and routing Widget (cost estimates, cheapest-model ladder, local-first), evals.
- The Python Widget SDK.
- Private Widgets and a private-mode Widget.
- GPU actions such as unloading models or preparing the GPU before work; the v1 GPU Widget is a read-only display.
- Apple Silicon support in the GPU monitor. Local Budgets already work on a Mac; the panel can follow later.
- Choosing a model automatically by Budget or by where Fable pays off. v1 records the data and shows it; routing is the later estimation and routing Widget.
- Migrating old board data (cards, costs, flags, usage history). Kiln starts with clean data apart from the Project import.
- Resuming or adopting Sessions started outside Kiln (for example, from a terminal).
- Other old-board features (Syncthing, weather, display, docs viewer, skill-run cards). They may come back later as Widgets.
- Retiring the old board. That happens after the cutover week, outside this spec.

## Further Notes

- **Cutover:** Kiln v1 is done when it has run the owner's real daily flow (registered Projects, default Workflow, Claude Code at home) for a week alongside the old board. The old board's code is frozen apart from needed bug fixes.
- **Decisions this spec made beyond the grill notes**, for the owner to check:
  - Budgets (metered, subscription and local) set per install, and their default limits: 500 credits per Session, 1,250 per Project per day, 5% of the week per Session, the 10-point pace rule, 10% reserves, and 300 turns or 2 hours for local.
  - Splitting a quota change across concurrent Sessions in proportion to their tokens.
  - The stall and context-alarm values.
  - The strictest-wins Policy merge, and "always allow" committing only the Project Policy file.
  - Story Stages that write to the repo also get worktrees, so no Session writes to the main checkout.
  - The markdown Tracker writes Stage and Status as small Kiln-authored commits on the default branch.
  - The Kiln tools over MCP for Sessions.
  - The `.kiln` folder for Project files.
  - The GPU monitor is display-only.
  - Unknown Tailscale users get no access until given a role.
- **Glossary gaps:** "Budget" (what a Session's usage draws from: metered, subscription or local), "Kiln tools" (the Session-scoped tools the core offers every Session), "run state" (idle, queued, running, paused, waiting on Gate, shipped, alongside Stage) and "capacity pool" aren't defined in `GLOSSARY.md` yet. Add them with `/domain-modeling` when the first Ticket uses them.
- **Usage units:** every usage number carries its Budget's unit (credits, quota percent, or turns and time), with API-equivalent dollars kept alongside for comparison. The runaway analysis (`docs/research/runaway-cost-analysis.md`) recommended storing plan-gauge readings (5h/7d), and v1 makes them the basis of the subscription Budget. Where Claude Code exposes them is an open fact for the Claude Code Widget's first Ticket to confirm.
