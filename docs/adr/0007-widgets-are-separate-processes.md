# Widgets are separate processes with Manifests

Each Widget runs as its own process, in any language, and talks to the core over one local API. Its Manifest declares what it provides, what it needs and which core versions it supports. The Platform enforces the Manifest, and a person approves it at install. The core installs, starts, stops, updates and removes Widgets without restarting itself. In the old board every feature was wired into `gpuboard\server.py`, so every change needed a board restart. Agents weren't allowed to do that restart, which led to the restart-when-idle subsystem and the unsolved UAC/session-0 problems. A crash anywhere also took everything down.

## Considered options

- **In-process plugins**: less code, but no permission boundary that corporate IT could rely on, and every update needs a core restart again. Rejected.
