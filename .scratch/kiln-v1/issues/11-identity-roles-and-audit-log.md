# 11: Identity, roles and audit log

**What to build:** Users, roles and an audit log, always on. There are two login adapters. In Local mode, Kiln binds to localhost only and the person at the PC is Admin, with no login. In Tailscale mode, Kiln also binds to the Tailscale interface and identifies each connecting peer through the local Tailscale daemon. An unknown tailnet user gets no access until an Admin gives them a role. The roles are Admin (users, caps and Budgets, Org Policy, Widget installs), Member (start work, chat, answer Asks, approve Gates) and Viewer (read-only). Every mutating request is checked against the caller's role, needs a CSRF token from the browser, and is written to an append-only audit log with its actor: a user, a Session and its Agent, a Widget, or Kiln. Admins get an audit log page in the Shell with filters. The Shell stays usable on a phone.

**Blocked by:** 01

**Status:** resolved

- [ ] Local mode serves only localhost and treats the local person as Admin
- [ ] Tailscale mode identifies peers through the Tailscale daemon; unknown users see nothing until given a role
- [ ] Viewers can't change anything, Members can't reach Admin settings, and refused requests are audited
- [ ] Mutating browser requests without a valid CSRF token are refused
- [ ] Every change is in the audit log with its actor, and Admins can filter the log in the Shell
- [ ] A browser test checks the Shell at phone width
