# 11: "Also create a private GitHub repo"

**What to build:** New gets a box, **Also create a private GitHub repo**. It's off by default and shown only when the GitHub Widget is installed and signed in. When ticked, after the first commit, the GitHub Widget creates a private repo named after the Project, Kiln adds it as `origin` and pushes `main`, and `.kiln/settings.json` gets `github.repo`. A failure here leaves the local Project registered and working, and says what to do. User story 5 in `spec.md`.

**Blocked by:** 02

**Status:** in-review

**Stage:** implementing

- [ ] The box is hidden without the GitHub Widget and off by default with it
- [ ] With a fake GitHub, ticking it creates a private repo, adds the remote and pushes
- [ ] A GitHub failure leaves the local Project intact, with a clear message
