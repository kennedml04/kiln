# Grill: Cap concurrent full test runs across worktrees

Story: `.scratch/test-run-lock/story.md`. Grilled 2026-11-06, one Ask per question.

## Context

- Every implementer runs `npm test` in its own worktree, and the Implementing Exit (`tests_pass`) runs the Project's `testCommand` (`npm test` here) again. One full run is about 9 minutes on an idle box and already uses `--test-concurrency=4`, many throwaway cores and Playwright browsers.
- On 2026-11-06 seven Implementing Sessions ran side by side and the box sat near 90% CPU.
- The "`npm test` exited with no code" failures are the Exit checker's own timeout: `packages/core/src/flow/exit-checker.ts` kills the command after `TEST_TIMEOUT_MS` (10 minutes), and a killed child closes with a null code. Sessions read it as an unexplained failure and re-ran the suite.
- The core has no concurrency limit of any kind today.

## Decisions

1. **The cap lives in this repo's `npm test`, not in Kiln core.** A small wrapper script takes a machine-wide slot before the run, so Agents' own runs and the Exit check's run (which is `npm test` too) queue behind the same slots. Only this repo is covered; a core-wide queue for other Projects is left for later, if one needs it.
2. **2 slots by default, overridable with an env var** (e.g. `KILN_TEST_SLOTS`), so it can be tuned without a code change.
3. **Core change: Exit check timeout 10 → 45 minutes, and a clearer message.** A killed command reports "timed out after N minutes" instead of "exited with no code". The timeout stays a constant (not a Project setting) for now.
4. **What takes a slot:** the whole `npm test` (check, Shell build, typecheck and suite) holds one slot, taken once (its own `test:only` step does not take a second one). `npm run test:only` on its own takes one too. Running one or a few files with `node --test <file>` stays free.
5. **Waiting:** the run prints a line when it starts waiting and every minute after (how many slots are in use, by which worktree, for how long), then "got a test slot after N min" when it starts. It **gives up after 40 minutes** with a clear "no test slot free after 40 min" error and a non-zero exit, so a queued Exit check fails with that reason before the 45-minute timeout. A slot held by a process that has died is freed.

## Implied behaviour

- The slots must be shared by every worktree and the main checkout, so they live in a machine-wide folder outside any checkout (e.g. under the OS temp folder), never under `%LOCALAPPDATA%\Kiln` or the old board's folder.
- The slot is released when the run ends, whether it passes, fails or is killed; a crash leaves a slot that the dead-process rule frees.
- Exit checks and Agents' runs share the slots on equal terms (first come, first served).
- The suite's own tests that run a `testCommand` inside a temp repo do not go through this wrapper, so they cannot deadlock on it.

## Still open (for the Spec)

- Lock mechanics: one file per slot holding PID, worktree and start time is the obvious shape; how to detect a dead PID on Windows and how to take a slot atomically (exclusive create) is for the Spec.
- How `npm test` tells its inner `test:only` that it already holds a slot (an env var set by the wrapper is the obvious way).
- The env var's exact name, and whether 0 or a negative value means "no cap".
- How to test the wrapper without the full suite: a fake command behind it, and an overridable slot folder so tests never touch the real one.
- Whether a waiting run should be friendly to an Agent's foreground shell timeout (Agents' Bash tool stops at 10 minutes); implementers may need a line in `CLAUDE.md` saying to run the full suite in the background and not to re-run it on a timeout.
- `CLAUDE.md` "How to build and test" should describe the slots, the env var and the 40-minute give-up.
