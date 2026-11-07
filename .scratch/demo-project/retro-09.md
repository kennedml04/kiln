# Retro: the first Live run, by hand (Ticket 09)

Live and a hand-run Replay both reached `shipped` (2026-11-05). `%TEMP%\kiln-scratch-repo` no longer exists; the demo replaces it.

## Snags and where each is filed
- Finished `claude.exe` holds its worktree, so `worktree remove` fails after a merge and the review Ask loops: Issue 10.
- Demo repo has no git identity of its own: Issue 11.
- Co-Authored-By trailers reached the demo `main`: fixed on branch `no-coauthor`.
- After a hand fix at Grill it was unclear the person had to press Start: raised as a Needs-you flag on the old board (auto-start, a "your move" cue, or a per-Stage setting). Not yet a Kiln Ticket.
- Setup wizard gives Opus to three of five roles and never suggests a local model: to revisit, not yet a Ticket.

## Still open
- "Every Kiln worktree for the demo was removed after its merge" stays unchecked until Issue 10 lands.
