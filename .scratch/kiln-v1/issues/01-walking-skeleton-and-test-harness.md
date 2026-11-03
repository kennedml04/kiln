# 01: Walking skeleton and test harness

**What to build:** The first end-to-end path through Kiln. A person runs `kiln start` and gets one core process (Node, TypeScript). It serves the local API and an SSE event stream, keeps its runtime state in one SQLite file in its data folder, and serves a React Shell page that shows it is connected and updates live from the stream. `kiln stop` and `kiln status` work too. The port and data folder default to 8300 and `%LOCALAPPDATA%\Kiln` and can both be overridden. Alongside it comes the core-API test harness: a test boots a real core on a free port with a throwaway data folder, creates a temp git repo, drives the API, reads the event stream, and tears everything down. Browser end-to-end tests of the Shell are wired to the same harness. The monorepo layout (core, Shell, Widget SDK, first-party Widgets) and the permission allowlist are set up from day one.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] `kiln start`, `kiln stop` and `kiln status` control one core process; `status` reports the port, data folder and uptime
- [ ] Port and data folder are configurable; the defaults are 8300 and `%LOCALAPPDATA%\Kiln`
- [ ] The core creates its SQLite file in the data folder on first start
- [ ] The Shell page loads from the core and shows a live connection state driven by SSE (no polling)
- [ ] The test harness starts a core on a free port with a throwaway data folder and a temp git repo, and cleans up after itself
- [ ] A harness test calls the API and receives an event over SSE
- [ ] A browser test loads the Shell through the harness
- [ ] Tests never touch port 8300 or 8195, `%LOCALAPPDATA%\Kiln`, or the old board's folder
- [ ] Only the name "Kiln" appears (no gpuboard, X-GPUBoard or Model Monitor)
