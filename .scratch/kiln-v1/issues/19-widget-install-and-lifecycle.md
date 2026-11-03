# 19: Widget install and lifecycle

**What to build:** Admins can install Widgets from a Widget source: the public repo, or a private local folder or private git repo. Kiln resolves the install to an exact tag or commit and writes it to a lockfile. It shows the Manifest (what the Widget provides and needs: data by Project scope, Asks, network domains, secrets, pools, its own data folder, and the supported core API range) and waits for Admin approval before starting it. An update that asks for more than before needs fresh approval. The Org Policy can restrict which sources are allowed. A Widget whose core API range excludes the running core isn't started and shows as incompatible. Install, start, stop, update and remove all happen without restarting the core, and running Sessions continue. A crashed Widget restarts with backoff and is marked unhealthy after repeated failures, and the core stays up. Requests outside a Widget's approved grants are refused and audited. A Widgets page in the Shell shows sources, installs, Manifests, approvals and health.

**Blocked by:** 02, 11

**Status:** resolved

- [ ] Installing from a local folder or a git repo pins an exact commit or tag in the lockfile
- [ ] Nothing runs until an Admin approves the Manifest, and an update with new needs asks again
- [ ] A source the Org Policy doesn't allow is refused
- [ ] An incompatible Widget isn't started and shows why
- [ ] Install, update and remove never restart the core, and a running Session keeps running throughout
- [ ] A Widget that crashes is restarted with backoff, then marked unhealthy, while the core stays up
- [ ] A call outside the Widget's grants is refused and audited
- [ ] The Widgets page shows all of this
