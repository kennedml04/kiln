# Kiln

Kiln is a board for organizing, running and talking to agent work across many Projects. It has a small core, and every other feature is a Widget.

## Core blocks

**Shell**:
The main board: home, navigation, the Needs you inbox, and the place where Widgets appear. It shows things but has no work logic of its own.
_Avoid_: GPU Board, Model Monitor, card board

**Work**:
The core block that owns Projects, their items, the single lifecycle those items move through, and the agent sessions working on them. It is the one source of truth for the state of any piece of work.
_Avoid_: tracker (a tracker is just where Work is stored)

**Platform**:
The core block for identity, roles, audit, hosting Widgets and their permissions, and the events the other blocks talk through.

## Work

**Project**:
A body of work, usually one repository, whose items Kiln tracks and runs. Each Project picks one Workflow.

**Item**:
A piece of work inside a Project. Items can have a parent Item and child Items, and each has an Item kind.
_Avoid_: card, task (unless a Workflow names a kind that)

**Item kind**:
A type of Item that a Workflow defines, together with the Stages it goes through. The default Workflow defines Epic, Story and Ticket.

**Epic** / **Story** / **Ticket**:
The default Workflow's Item kinds. An Epic groups Stories. A Story is grilled, specced and split into Tickets. A Ticket is implemented and reviewed.

**Workflow**:
The ordered Stages a Project's items move through, the agent role bound to each Stage, and what counts as done. Each Project chooses its own in `.kiln/workflow.json`; without one it runs Kiln's default. An invalid file is reported and the Project keeps its last valid Workflow.
_Avoid_: process, pipeline

**Stage**:
One step of a Workflow (for example Grill, Spec or Review). The Stage an item is in decides which agent role works on it.
_Avoid_: column, lane (a column is just how a Stage is drawn)

**Run state**:
Where an Item is in its run, alongside its Stage: Backlog, Up next, Running, Waiting (on a Gate or an Ask) or Shipped. The all-Projects board groups Items by run state; a Project's board groups them by Stage.
_Avoid_: status (Status is the Tracker's triage field)

**Exit**:
What must exist for an item to finish a Stage (for example, a written spec). When the Exit is met, the item moves to the next Stage by itself.
_Avoid_: done marker

**Gate**:
A Stage whose Exit also needs a person's approval, given by answering a Review ask in Needs you. People move items forward only through Gates, never by dragging.
_Avoid_: checkpoint, sign-off

**Thread**:
The single conversation history of one Item or Project, across all its Stages. People talk to the Item or Project through its Thread, never to a particular Agent. A Project's Thread can read everything and propose changes, but never makes them itself.
_Avoid_: chat tab

**Session**:
One agent run working on an item for one Stage, started fresh and seeded with the item's artifacts. A Thread holds many Sessions in order.
_Avoid_: card run

**Tracker**:
Where a Project's Item records live (their content and Stage). It is pluggable: markdown in the Project's repo by default, with GitHub Issues or Jira as Widgets.
_Avoid_: issue tracker, backlog (a backlog is a view)

**Policy**:
The rules saying which abstract actions Sessions may take (allow, ask or deny). It is layered: Org, then Project, then Stage, and each lower layer can only tighten the one above.
_Avoid_: permissions, allowlist, settings

**Ask**:
A request for a person's input, raised by a Session or a Gate. It is typed (Decision, Permission, Review or Question), names its Item, says why it matters, carries a recommended answer, and is either blocking or non-blocking.
_Avoid_: flag, alert, blocker, notification

**Needs you**:
The single inbox in the Shell that holds every open Ask, sorted by how much work each one blocks.
_Avoid_: Your turn

**Kiln tools**:
The tools Kiln gives every Session over MCP, scoped to that Session's own Item: raise an Ask, read the Item, read its artifacts, write its Digest. A Project Thread Session's tools are scoped to its Project instead: read any of its Items, their artifacts and Digests, and propose changes as Asks that Kiln applies only when a person accepts.
_Avoid_: Kiln MCP, board tools

**Digest**:
A short record a Session writes when it ends: what was decided, what changed and what is still open. New Sessions start from artifacts plus Digests, never from a raw Thread. Many Digests can be rolled up into one.
_Avoid_: summary, handoff note

**Knowledge store**:
Where Kiln keeps what people and Agents read: Digests, decisions, retros and notes. It is chosen at setup, defaults to a markdown folder (which can be an Obsidian vault), and is separate from Work data.
_Avoid_: vault (the vault is one possible Knowledge store), brain, memory

**Agent**:
A coding agent tool (for example Claude Code) that runs Sessions. The core knows Agents only through one interface; each Agent is added by a Widget.
_Avoid_: model, bot, worker

**Scheduler**:
The part of Work that starts queued Sessions when their capacity pool has room, in Up next order (Item priority, then age). Stop all halts it until a person resumes it.
_Avoid_: queue runner, dispatcher

**Capacity pool**:
A named number of Sessions that may run at once (default `agents: 3`). A Stage says which pool its Sessions use; Widgets and Budget kinds can add pools (the GPU monitor adds `gpu: 1`).
_Avoid_: slot pool, concurrency limit, lane

## Budgets

**Budget**:
What a Session's usage draws from: metered credits, a subscription's quota windows, or local models. Each install sets up its own Budgets, and every model a Workflow can name belongs to exactly one Budget. Reaching a limit pauses the work and raises an Ask; it never kills it.
_Avoid_: quota (a quota window is one part of a subscription Budget), credits, plan

**Runaway**:
A Session that keeps spending without making progress. Kiln's runaway guards are the Budget caps, the stall rule and the context alarm.
_Avoid_: loop, runaway cost

**Stall**:
A Session that has gone several turns (8 by default) with no new commit and no artifact change, or that repeats the same tool call with the same arguments. Kiln pauses it and raises an Ask. A Session that keeps finishing with its Exit unmet is bounded by this rule too: each unmet Exit round with nothing new made counts as a turn. There is no separate cap on Exit rounds.
_Avoid_: hang, stuck (a stalled Session is still running)

**Variant**:
One model + quant + settings combination (context size, GPU layers, KV cache type, threads) that the local model server runs. Kiln keeps a record of each: enabled, disabled with a reason, or removed (its results stay), and its last smoke test. Kiln writes a variant's own entry in the server's config; an entry written there by hand shows up as a variant that can be enabled.
_Avoid_: model (one model has many variants), profile, preset

## Extension

**Widget**:
A separately installed feature that plugs into the core: anything that is not Shell, Work or Platform. It comes from either the public widget repo or a private local one.
_Avoid_: module (a Module is something else), plugin, card type

**Module**:
A small declarative file (`kiln-module.json`) for one kind of work, such as CAD part, 3D print or Electronics: the skills, MCP servers, Exit checks, Stages and starter files it brings, and the Widgets it needs. A Project lists its modules in `.kiln/settings.json` and can mix them. Modules come from module repos (Kiln ships one, `modules/`) or the Project's own `.kiln/modules/`. A Module is not a Widget: it runs no code inside Kiln. Its Exit checks run as commands in the Item's worktree and its MCP servers inside the Session, under the Session's Policy.
_Avoid_: project type (a type is only a wizard preset that ticks modules), plugin, Widget

**Widget source**:
A git repo or local folder that Widgets are installed from: the public repo (alongside the core) or a private one. Installs are pinned to an exact version, and the Org Policy can limit which sources are allowed.
_Avoid_: marketplace, registry

**Manifest**:
A Widget's declaration of what it provides, what it needs (which data, Asks, network) and which core versions it supports. The Platform lets a Widget do only what its Manifest declares and a person approved.

**Grant**:
One thing an Admin approved a Widget to do or read, from what its Manifest needs (events, Asks, secrets, a pool, network). A request outside a Widget's grants is refused and audited; an update that needs more waits for fresh approval.
_Avoid_: permission (Permission is an Ask type), scope

**Secret**:
A value a Widget needs (for example an API token), named in its Manifest, entered by an Admin and kept in the OS credential store. Only the Widget granted it can read it; Kiln never writes it to its own files or the audit log.
_Avoid_: credential, key, token (unless naming the kind of Secret)

**Widget source policy**:
The part of the Org Policy that says which Widget sources Widgets may be installed from. Unset, any source is allowed.
_Avoid_: allowlist, trusted sources

**Panel**:
A Widget's view in the Shell, described as data (cards, stats, tables, buttons) for the Shell to draw, so a Widget needs no frontend code. A button on a Panel runs one of the Widget's named actions.
_Avoid_: card, tile, widget UI
