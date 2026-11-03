# 24: GitHub Issues Tracker and PR mode

**What to build:** A first-party Tracker Widget that keeps a Project's Items in GitHub Issues. Item kind and Stage are labels, parent and child are sub-issues, and Status is open or closed plus a label. Kiln writes only the Stage and Status fields, and Agents write the content through the Kiln tools. The Widget also gives PR-mode Projects (set in `.kiln` settings) a way to ship. On Review Gate approval, Kiln pushes the branch and opens a PR instead of merging, then removes the worktree. The Ticket stays in Review until the Widget detects that the PR was merged, then moves to Shipped. Pushes and PRs go through the Policy as external writes. The Manifest declares GitHub's API domain and a named token secret. A Tracker contract suite runs against the markdown Tracker and this Widget; the GitHub run is opt-in, against a throwaway repo.

**Blocked by:** 07, 09, 20

**Status:** resolved

- [ ] A Project set to the GitHub Tracker shows its issues as Items with the right kinds, Stages and parents
- [ ] Stage changes appear as label changes on GitHub, and content edits come only from Sessions
- [ ] In PR mode, approving the Review Gate opens a PR, and merging it on GitHub ships the Ticket
- [ ] Push and PR are external writes under the Policy
- [ ] The token is a Platform-held secret
- [ ] The Tracker contract suite passes against both the markdown Tracker and this Widget
