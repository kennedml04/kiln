---
title: Serialize command Exit checks
epic: platform
stage: grill
---
On 2026-11-06 seven Implementing Sessions ran their test suites at the same time, each run took too long, `tests_pass` failed, and the Agents re-ran the suite in a loop for hours. The churn watchdog (`.scratch/churn-watchdog/`) only notices this loop. This story deals with the cause.

`.scratch/test-run-lock/` already caps full test runs for this repo with a machine-wide slot wrapper around its own `npm test`, and it raises the Exit check timeout from 10 to 45 minutes. That covers Kiln's own repo, not other Projects. This story is the core-side part that story left for later.

- Kiln core runs command Exit checks (`tests_pass` and module command checks) one or two at a time per Project, or across the whole machine, so other Projects get the same protection without a repo wrapper.
- A Running card whose Exit check is queued shows "waiting for a test slot", and the time it waits does not count toward the churn watchdog's clock.
- The Exit feedback for a failed command check includes fuller failure output (the failing tests and their messages, not only the tail), so the Agent does not re-run the whole suite just to see why it failed.

## To grill

- Per Project or machine-wide slots, and how many by default. How this works alongside the repo-side `test-run-lock` wrapper (two queues for this repo, or the core respects the wrapper)?
- Whether the Agents' own test runs can be queued too, or only the Exit checks the core runs.
- How much failure output to include, and how to pick it out (the last N lines, a parsed `node --test` summary, or the whole log saved as an artifact and linked).
- Whether a queued Exit check counts as running time for the churn watchdog (the watchdog's grill says only running time counts, so queued time probably does not).
