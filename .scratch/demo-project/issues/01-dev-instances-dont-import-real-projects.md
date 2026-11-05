# 01: Dev instances don't import real Projects

**What to build:** A dev instance can no longer import the old board's real Projects. On a dev core (`config.devInstance`), `POST /api/setup/import` refuses with 409 and the message "Dev instances don't import real Projects; add one by hand if you mean to". The setup wizard drops its Import step when `GET /api/status` reports `instance: 'dev'`. A live instance behaves exactly as before. Adding a Project by hand still works on dev. The Demo step that takes Import's place comes in 07, so this Ticket just ends the dev wizard after Workflow roles. See "The setup wizard (shell)" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `POST /api/setup/import` returns 409 with that message on a dev core, and imports as before on a live core (extend `packages/core/test/setup.test.ts`)
- [ ] `GET /api/setup` on a dev core does not list old-board Projects to import
- [ ] The dev wizard has no Import step; the live wizard still has it
- [ ] Registering a Project by hand still works on a dev core
