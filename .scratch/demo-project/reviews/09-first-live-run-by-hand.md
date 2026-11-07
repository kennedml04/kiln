# Review: 09 The first Live run, by hand

Branch `kiln/ticket/demo-project/09` against `demo-project`. It has two commits:
- 7b53c7a: adds `.scratch/demo-project/retro-09.md`.
- 93980da: adds `.kiln/settings.json` with `{ "testCommand": "npm test" }`.

No code changes. The Ticket says "Nothing new", so that is expected.

## Against the Ticket's boxes

- **Live reaches `shipped`.** Done by a person on 2026-11-05 and recorded in the Ticket file on `demo-project`. The Ticket notes that the "and its CLI" part of this box was out of date. The retro does not repeat that, which is fine.
- **Permission requests reached Needs you as Asks.** Ticked on `demo-project`. The retro doesn't mention it. That's acceptable, because nothing went wrong.
- **Worktrees removed after each merge.** Not met. The retro says so and links it to Issue 10 (`10-finished-session-holds-its-worktree.md`, which exists on `demo-project`). That's correct: this box can't be ticked from this branch.
- **Hand-run Replay reaches `shipped`.** The retro records it.
- **Each snag filed; old scratch repo deleted.**
  - I checked that `%TEMP%\kiln-scratch-repo` is gone.
  - Snags in the Ticket file: Issue 10 (filed), Issue 11 (filed, `11-demo-repo-git-identity.md`), and Co-Authored-By (fixed on `no-coauthor`).
  - "Whose move after a hand fix at Grill" is filed on the old board only.
  - "Wizard gives Opus to three roles" is not filed anywhere.
  - The Ticket allows a snag to be "a Ticket or a retro note", so listing these two in `retro-09.md` meets the letter of the box. The box can be ticked once a person agrees that a retro line is enough for those two.

## Findings

1. **`.kiln/settings.json` will conflict with `kiln/ticket/local-first/08` (should fix before merge).**
   - Commit 93980da adds `.kiln/settings.json` as a one-line `{ "testCommand": "npm test" }`.
   - Commit 652782f on `kiln/ticket/local-first/08` adds the same file with the same value, spread over three lines.
   - Both add the same new file with different text, so whichever branch merges second gets an add/add conflict.
   - The commit is also outside this Ticket's scope. It is project setup for the Exit's tests check, not part of the Live run.
   - Suggested fix: drop 93980da from this branch and let the setting come in through local-first/08 (or its own commit on the main line). If it has to stay, match local-first/08's formatting byte for byte so git can merge it cleanly.

2. **The retro only points to the record of the run; it doesn't repeat it (minor, no change needed).**
   - The Ticket file on `demo-project` holds the actual record: dev instance 8412, demo repo `demo\3`, `node --test` 14 of 14, and no CLI.
   - The retro keeps only the snag list.
   - That's fine because both will be on the main line after merge. Just don't delete the Ticket's "The Live run" section later on the assumption that the retro covers it.

3. **The Co-Authored-By fix is only on branch `no-coauthor` (just noting).**
   - The retro says "fixed on branch `no-coauthor`". There is no local `no-coauthor` branch in this repo, so it presumably lives in another repo (the old board or the demo).
   - The retro line would be clearer if it named the repo.

## Verdict

The retro is accurate and matches the Ticket's record. Approve once finding 1 is dealt with.

Still open (not blocking this branch):
- The worktree box waits on Issue 10.
- A person needs to decide whether the two retro-only snags (the "your move" cue, and the wizard's model defaults) need Kiln Tickets before the last box is ticked on `demo-project`.
