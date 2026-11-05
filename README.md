# Kiln

Kiln is a local board for running coding agents across many projects. It has a small core that owns the work (Projects, Items, Stages, Gates and Sessions), permissions and runaway-cost protection. Everything else, including the agents themselves, is a Widget: a separate process the core installs, starts and supervises.

- **One work model.** Epics, Stories and Tickets move through the Stages of a Workflow. An Item moves forward when Kiln checks that its Stage's Exit is met, or when a person approves a Gate in the Needs you inbox.
- **A fresh Session per Stage, a worktree per Ticket.** Each Ticket gets its own git worktree and branch. Kiln checks the Exit (commits, clean tree, tests pass) and merges, or opens a pull request. Whatever the Workflow says, every Stage with a worktree also checks that no commit on the branch has a `Co-Authored-By:` trailer (the Agent is told to rewrite those messages), and the merge and the pull request refuse such a branch.
- **Kiln owns the Policy.** One layered Policy (Org → Project → Stage) over abstract actions, translated by each Agent Widget into its tool's own settings. Permission requests become Asks.
- **Budgets on by default.** Metered (credits or dollars), subscription (plan usage windows) and local (turns and time) Budgets, with per-Session caps, pacing, reserves, a stall rule, a context alarm and Stop all.

The design lives in `.scratch/kiln-v1/spec.md`, the vocabulary in `GLOSSARY.md` and the decisions in `docs/adr/`.

## Install

Kiln needs Node 24 or later, npm 11 and git. It is developed and tested on Windows.

```powershell
git clone https://github.com/kennedml04/kiln.git
cd kiln
npm ci
npm run build
node packages/core/src/cli.ts start
```

Then open http://localhost:8300. The setup wizard picks the login mode, the Knowledge store, the Budgets and the Agents.

To add a Project, press **+ Project** → Import on the board and pick its folder in the tree, or type its path. The tree shows only the browse roots and the Projects folder an Admin sets in Settings → Folders (a dev instance browses its own data folder). It skips hidden and system folders and never follows junctions. The folder must be the top of a git repo with a commit, on its default branch; otherwise Kiln refuses with the fix. It never switches branches for you. A folder that isn't a git repo yet gets an **Initialise as a git repo** button.

The `kiln` CLI:

| Command | What it does |
| - | - |
| `kiln start`, `kiln stop`, `kiln status` | Run the core in the background, stop it, show its port and uptime |
| `kiln doctor` | Check the port, data folder, git, Widgets and Agents, and say how to fix each problem |
| `kiln restart` | Restart when idle: wait until no Session runs, then restart |
| `kiln startup on` | Start Kiln when you log in, with no window |
| `kiln dev` | A dev instance on a free port with a throwaway data folder |

The port defaults to 8300 (`--port` or `KILN_PORT`) and the data folder to `%LOCALAPPDATA%\Kiln` (`--data-dir` or `KILN_DATA_DIR`). The default login mode is local: localhost only, and the person at the PC is Admin. Tailscale login (`--login tailscale`) lets you reach the board from other devices on your tailnet.

## Widgets

A Widget is a folder with a `kiln-widget.json` Manifest that says what it provides (Agents, Trackers, panels) and what it needs (Asks, network domains, a data folder). Widgets are installed from this repo or from a private Widget source (a local folder or a private git repo), pinned in a lockfile, approved by a person, and started, stopped or updated without restarting the core.

First-party Widgets in `widgets/`:

- `claude-code`: the Claude Code Agent, through the Claude Agent SDK, with subscription quota readings.
- `github`: a GitHub Issues Tracker.
- `gpu-monitor`: a read-only NVIDIA GPU panel.

Widgets talk to the core only through its local API with their own credential. The TypeScript Widget SDK (`packages/widget-sdk`) has the Manifest types, the API client and the Agent and Tracker interfaces.

## Develop

```powershell
npm ci
npx playwright install chromium
npm test
```

`npm test` checks the lock file and banned patterns, builds the Shell, typechecks and runs every test. Tests start a real core on a free port with a throwaway data folder (`startTestKiln` from `@kiln/testing`) and never touch the live Kiln. Node runs the TypeScript directly, so only the Shell has a build step. `CLAUDE.md` has the rules agents follow in this repo.

## License

MIT. See `LICENSE`.
