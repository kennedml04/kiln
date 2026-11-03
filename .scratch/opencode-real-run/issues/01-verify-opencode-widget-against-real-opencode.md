# 01: Verify the OpenCode Widget against a real OpenCode install

**What to build:** Run the OpenCode Agent Widget's gated real suite on a machine with OpenCode installed and a provider configured. Fix whatever the real run turns up. The Widget was built and merged in kiln-v1 ticket 23 (`.scratch/kiln-v1/issues/23-opencode-agent-widget.md`). Its scripted tests pass, but three things in it have never been checked against a real OpenCode: `opencode serve --port 0`, the event shapes in OpenCode 1.14 and later, and `/config/providers`. The machine's global OpenCode config also merges in under the Session's config, so check that it doesn't override the Policy or the `kiln` MCP server.

How to run it, from the repo root in PowerShell:

- metered: `$env:KILN_REAL_OPENCODE='1'; $env:KILN_REAL_OPENCODE_MODEL='<provider>/<model>'; node --test --test-timeout=900000 widgets/opencode/test/real-opencode.test.ts` (hard cap `KILN_REAL_OPENCODE_MAX_USD`, default 0.05)
- local (optional, if the machine has a local model server): also set `KILN_REAL_OPENCODE_LOCAL='{"<provider>":{"baseURL":"http://127.0.0.1:<port>/v1","models":["<model>"],"contextWindow":32768}}'`, with `<provider>` matching the provider part of the model
- `KILN_REAL_OPENCODE_CMD` (JSON list) if `opencode` isn't on PATH

The Widget refuses OpenCode 2.x; check `opencode --version` first.

**Blocked by:** kiln-v1 23 (merged)

**Status:** ready-for-human

- [ ] A real Ticket runs through Implementing with OpenCode and passes the Exit check
- [ ] The Policy translation and Permission Asks behave exactly as they do for the Claude Code Widget
- [ ] Usage reaches Kiln for the metered model against its own Budget (and for a local model against a local Budget, if one is available)
- [ ] The shared Agent contract suite passes, unchanged, against this Widget
