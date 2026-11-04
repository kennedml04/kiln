# 01: Proxied requests are never the local Admin

**What to build:** A request that reaches Kiln through a reverse proxy on this PC (`tailscale serve`, or any other) is never treated as the person at the PC. In Tailscale mode, a request from `tailscale serve` is treated as the tailnet user it names, with that user's role. Any other proxied request gets no access. Then `tailscale serve` is safe to use in front of Kiln (it gives HTTPS on a `*.ts.net` name, which phones and installed web apps prefer), and the setup wizard no longer has to warn people off it. Discussed 2026-11-03.

Today `identify` in `packages/core/src/login.ts` returns `'local'` (the Admin) for every loopback request. A proxy's requests all arrive from loopback, so every caller behind it becomes the local Admin. If Funnel is also on, that includes anyone on the internet. Kiln already spots proxies (`packages/core/src/operations/proxy.ts`), but only to fail `kiln doctor` and to show `TAILSCALE_SERVE_WARNING` in the wizard.

Decisions:

1. **Proxy headers mean "not local".** A loopback request that carries any proxy header (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Tailscale-User-*`; the same list `proxy.ts` uses) is never `'local'`, in either login mode. The header list lives in one place and both `login.ts` and `proxy.ts` use it.
2. **Trust `tailscale serve`'s identity headers in Tailscale mode.** `tailscale serve` adds `Tailscale-User-Login` (and `Tailscale-User-Name`) for tailnet callers and strips any copies the caller sent. In Tailscale mode, a loopback request with `Tailscale-User-Login` is the Peer `{ id: <login>, name: <name> }`, the same identity `tailscale whois` would give, so it gets that person's role. Unknown users get no access, as today.
3. **Why trusting the header is safe:** only a program already running on this PC can send a loopback request with a forged header. That program could leave the header off and be the local Admin, so forging it can only lower its access, never raise it.
4. **No identity, no access.** A proxied request without `Tailscale-User-Login` (Funnel traffic from the internet, or a proxy other than `tailscale serve`) is `undefined`: no access. In Local mode, every proxied request is `undefined`.
5. **Doctor and wizard follow.** The proxy check passes when `tailscale serve` fronts Kiln in Tailscale mode. It warns instead when serve fronts Kiln in Local mode (remote callers get no access), when a non-Tailscale proxy is seen (callers get no access), and when Funnel is on for Kiln's port (internet callers get no access, so it does nothing useful). The wizard drops the "Turn it off before you go on" alert and the long warning. At most it keeps a one-line note that `tailscale serve` works.
6. **The test-mode peer header stays.** `x-kiln-test-peer` keeps working as it does now. Tests for this ticket send the real `Tailscale-User-Login` header instead.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] In Tailscale mode, a loopback request with `Tailscale-User-Login: alice@example.com` acts as alice: her role applies, and the audit log names her, not the local person
- [x] In Tailscale mode, a loopback request with `Tailscale-User-Login` for a login with no role gets no access
- [x] A loopback request with `X-Forwarded-For` (or `Forwarded`, `X-Real-IP`) and no `Tailscale-User-Login` gets no access, in both login modes
- [x] In Local mode, a loopback request with `Tailscale-User-Login` gets no access
- [x] A plain loopback request with no proxy headers is still the local Admin, in both modes
- [x] The event stream (SSE) and every other endpoint use the same identity rule as the REST API
- [x] `kiln doctor`'s proxy check passes with `tailscale serve` in front of Kiln in Tailscale mode, and warns in the cases listed in decision 5
- [x] The setup wizard no longer blocks or warns when `tailscale serve` fronts Kiln in Tailscale mode
- [x] Tests use the fake `tailscale` CLI (`KILN_TAILSCALE_CLI`) and real HTTP headers, never the PC's real Tailscale

## Comments

2026-11-03, built:

- `login.ts` owns the proxy header list (`PROXY_HEADERS`, now also `Tailscale-User-Name`). `proxy.ts` uses the same list. Display names in RFC 2047 encoding (which serve uses for names that aren't plain ASCII) are decoded.
- Found while building: a raw TCP forward (`tailscale serve --tcp`) adds no headers, so its callers would still be the local Admin. The doctor check **fails** on it, and the wizard shows an alert. `proxy.ts` now reads `tailscale serve status --json` as a ServeConfig (Web handlers, TCP forwards, `AllowFunnel`, foreground sessions and Services) instead of matching text, so it can tell a web proxy from a TCP forward and spot Funnel.
- `TAILSCALE_SERVE_WARNING` became `TAILSCALE_SERVE_NOTE`. `SetupState.tailscale.servesKiln` is now `{ target, kind, funnel }`.
