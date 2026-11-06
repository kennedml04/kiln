# Spec: Show a running Session's steps in its Thread, folded by default

Status: ready-for-agent

Sources: `.scratch/thread-reasoning-steps/story.md`, `.scratch/thread-reasoning-steps/grill.md` (decisions 1–7, numbered as there), and the code on branch `kiln/story/thread-reasoning-steps` (2cf45ba). The Claude Code Widget emits steps in `widgets/claude-code/src/agent.ts` `onMessage`; core publishes them as `session.progress` in `packages/core/src/flow/session-manager.ts` (`routeAgentEvents`) and builds `ItemRun` in `toRun`; the Shell draws the Thread in `ThreadLog` and `describe` (`packages/shell/src/work/ItemView.tsx`) and the card in `packages/shell/src/work/ItemCard.tsx`.

## Problem Statement

- The Thread is concise, which is worth keeping, but while a Session works the person can't tell it is moving.
- The steps already arrive. The Widget sends a `progress` event for every `tool_use` block (`{ tool: { name, input } }`) and every top-level text block (`{ text }`); core publishes each as `session.progress`, streams it over SSE and never prunes it.
- But `describe` shows a tool call as a bare `Tool: Read` with no input, and a note as its full text, one flat line each. So the tool lines say nothing, and the notes swamp the Thread.
- A running card shows nothing. Only `Paused` has a cue.

## Solution

1. **Readable step lines.** A tool call reads as a verb plus its key argument (`Read packages/core/src/cli.ts`, `Ran npm test`); a note as its first line.
2. **Folded groups.** Each run of consecutive steps becomes one `Steps (n)` group, folded by default. Opened, it lists one line per step; each line opens again for the step's detail. A group still filling shows its latest step in its header.
3. **Kept.** Steps stay in the Thread after the Session ends, folded, as today. No deletion.
4. **Movement on the card.** A running card shows a pulse dot and "last step 12s ago", from a new `run.lastStepAt`.
5. **Same readers, cut sizes, no masking.**
6. **Phone:** the same groups, one ellipsised line per step, tap to expand.

This is Shell work plus one small core addition (`lastStepAt`). The Widget does not change.

## User Stories

### Seeing steps

1. As the person, when I open a Ticket while its Session works, I want to see what it read, ran and edited and its short notes, as they happen, so I know it is moving.
2. As the person, I want each tool call to say what it acted on (`Read cli.ts`, `Ran npm test`), not just `Tool: Read`.
3. As the person, I want the steps folded into one `Steps (n)` line between the other Thread entries, so the Thread stays concise.
4. As the person, I want a group that is still filling to show its latest step in its header, so I see movement without opening it.
5. As the person, I want to open a group to see one line per step, and open a step to see its detail (the full path, command, pattern, or the note's full text).
6. As the person, I want what I have opened to stay open while new steps arrive, and my selection and scroll position kept, as the Thread does now.
7. As the person, I want the steps of a finished Session kept in the Thread, folded, so I can see later what it did.

### Size

8. As the person, I want a very long value (a big command, a long note) cut at about 2,000 characters with a "show all", so one step can't flood the page.
9. As the person, I want a Write or Edit to show as "+N lines" or "-N/+M" rather than the file contents.

### The card

10. As the person, I want a running Ticket's card to show a pulse and "last step 12s ago", so I can see from the board that it is moving, and spot one that has stalled by a time that keeps climbing.
11. As a person who has turned on reduced motion, I want a still dot instead of a pulse.

### Phone

12. As the person on my phone, I want the same groups, one line per step that doesn't wrap, and tap targets big enough to hit.

### Everywhere the Thread is shown

13. As the person, I want the Project Thread (and the Scratch chat Thread, which shares `ThreadLog` once it is merged) to group steps the same way.

## Implementation Decisions

### Step lines (decision 1)

A pure function in the Shell, e.g. `packages/shell/src/work/steps.ts`: `stepLine(payload) → string` and `stepDetail(payload) → { label, value }[]`. Tool inputs are untrusted shapes: read every field defensively (strings only; anything else is ignored).

The verb mapping (the grill left it to the Spec):

| Tool | Line | Detail fields |
| --- | --- | --- |
| `Read` | `Read <file_path>` (`, lines a–b` when `offset`/`limit` given) | path, offset, limit |
| `Write` | `Wrote <file_path> (+N lines)` | path, "+N lines" (count of `content` lines) |
| `Edit` | `Edited <file_path> (-N/+M)` | path, "-N/+M" from `old_string`/`new_string` line counts, "all occurrences" when `replace_all` |
| `MultiEdit` | `Edited <file_path> (k edits)` | path, k edits, summed -N/+M |
| `NotebookEdit` | `Edited <notebook_path>` | path, cell id, edit mode |
| `Bash`, `PowerShell` | `Ran <command>` | command, description, "in background" when set |
| `Grep` | `Searched "<pattern>"` (` in <path>` when given) | pattern, path, glob/type |
| `Glob` | `Listed <pattern>` | pattern, path |
| `Task` / `Agent` | `Started subagent: <description>` | description, subagent type, prompt |
| `WebFetch` | `Fetched <url>` | url, prompt |
| `WebSearch` | `Searched the web for "<query>"` | query |
| `TodoWrite` | `Updated the to-do list` | each to-do's text and status |
| `mcp__<server>__<tool>` | `<server>: <tool>` plus its first string field, e.g. `kiln: raise_ask "Which…"` | every top-level string field |
| anything else | `<name>` plus its first string field | every top-level string field |

- File paths in the line are shown relative to the Session's worktree when they are inside it (from `item.run.worktree` when known), else as given. The detail shows the path as given.
- A command's line is its first line only.
- A note (`{ text }`) line is its first non-empty line. Its detail is the full text.
- A progress entry with neither field (should not happen) reads `Working`, as now.
- The line is never cut in the data; the CSS ends a folded line in an ellipsis (`text-overflow: ellipsis`, `white-space: nowrap`). The full text is in the line's `title`.
- Subagent tool calls show like any other step. The Widget already leaves subagent text out; that stays.

### Grouping (decision 2)

- `ThreadLog` turns the entry list into display rows before drawing: consecutive `session.progress` entries form one group. `session.usage` and `session.quota_reading` entries (and any other unknown `session.*` type that is not in the list below) do not end a group; they are carried inside it, not counted, and shown inside the opened group as muted lines in their place, as they are today.
- Every other Thread entry ends a group: `session.started`, `session.finished`, `session.updated`, `session.message`, `session.permission_request`, Ask entries, `exit.checked`, `digest.written`, `item.stage_changed`.
- A group's header: `Steps (n)` with a +/- toggle, n the count of `session.progress` entries in it.
- **Filling:** a group is filling when it is the last row of the Thread. Then its header also shows the latest step's line (`Steps (42) · Ran npm test`). A Session that pauses, finishes or is interrupted always adds an entry that ends the group, so a filling group is always a working one. No timer is needed.
- Group keys are the id of the group's first entry, so a group keeps its identity (and its open state) as steps are appended to it.
- **Fold state** lives in `ThreadLog` component state: a set of open group ids and a set of open step ids. It is not saved, and it resets when the view changes. New entries never change it.
- The existing rules stay: new rows are appended without re-rendering the old ones (the selection survives), and the log follows the bottom only when the person is already there. The effect that scrolls to the bottom must also run when the filling group grows or a fold opens at the bottom, not only on `thread.length` (keyed on the last entry id is enough).
- Opening a step shows its detail fields as a definition list, each value in a `<pre>` when it is a command, note or prompt.
- `aria-live="polite"` stays on the log. The filling header changes on every step, so it must not be announced each time: mark the header's latest-step text `aria-live="off"` (or render it outside the live region's announced content). A screen reader hears a new group, not every step.
- The toggles are `<button aria-expanded>` elements, so they work by keyboard. A step with nothing to show beyond its line (a one-line note) has no toggle.

### Size and privacy (decision 5)

- Steps go through the existing Thread API and SSE, with the same readers. No new access rule, no new route.
- A detail value longer than 2,000 characters shows its first 2,000 and a "show all" button. Showing all is per step and not saved.
- Write/Edit contents never show inline, only their line counts.
- No secret masking in this story.

### `run.lastStepAt` in core (decision 4)

- `ItemRun` (in `packages/widget-sdk/src/flow.ts`) gains `lastStepAt?: string`, an ISO time. Its doc comment: the time of the Session's latest step (any `session.progress`, tool call or note), while it runs.
- Counts every `session.progress`, notes included (the grill's proposal, taken).
- In `routeAgentEvents`, on a `progress` event: set `session.info.lastStepAt` (kept on the live Session's info, not stored in the database) and call `work.setRun(itemId, toRun(info))`, like `noteUsage` does. `toRun` copies `lastStepAt` when set.
- Throttle: at most one `item.updated` for `lastStepAt` per Session every 5 seconds. A step inside the 5 seconds updates the stored value; a trailing timer publishes it at the end of the 5 seconds, so the last step is never lost. The first step of a Session publishes at once. The timer is cleared when the Session ends.
- After a core restart the live info has no `lastStepAt` until the next step. The card then shows the pulse without a time.
- `lastStepAt` is not cleared when the Session ends; the Shell simply doesn't show it unless the run is running.

### The card (decision 4)

- In `ItemCard.tsx`, beside the existing `Paused` cue: when `item.run?.state === 'running'` and `item.run.stage === item.stage`, show a dot (`.running-pulse`) and, when `lastStepAt` is set, "last step 12s ago".
- The relative time comes from one shared Shell clock (a small hook, e.g. `useNow(1000)`, one interval for the whole board, not one per card). Format: `Ns ago` under a minute, `Nm ago` under an hour, `Nh ago` after.
- The pulse is a CSS animation; under `@media (prefers-reduced-motion: reduce)` it is a static dot. The dot has `aria-hidden`, and the card's accessible text reads "Running, last step 12s ago".
- Not shown when paused (the card already says Paused), waiting, or finished.

### Phone (decision 6)

- The same rows. Folded lines don't wrap (ellipsis). Group headers and step lines are buttons at least 44px tall at the phone width (`@media (max-width: 640px)`, as the other phone rules). The detail's `<pre>` blocks scroll sideways rather than widen the page.

### Where it applies (decision 7)

- `ThreadLog` is shared, so the Item Thread and the Project Thread both get grouping. The Scratch chat view gets it too if it uses `ThreadLog` when merged; if it has its own log, it should be moved onto `ThreadLog` in this story or left to a follow-up (the Builder notes which in its Digest).

## Testing Decisions

Tests drive Kiln from outside, per CLAUDE.md: `startTestKiln(t)`, `openShell(t, kiln)`, and the scripted fake Agent (`kiln.installFakeAgent({ script })`) to send `progress` events with chosen tool inputs. No asserting on internal modules or tables. The pure step-line function may also have plain unit tests in the Shell package.

- **Step lines:** a fake Agent sends a Read, a Bash, an Edit, a Grep, an MCP tool, an unknown tool and a multi-line note; the opened group shows `Read <path>`, `Ran <command>`, `Edited <path> (-N/+M)`, `Searched "<pattern>"`, `<server>: <tool> …`, the fallback, and the note's first line.
- **Grouping:** steps, then a person's message, then more steps, give two `Steps (n)` groups with the right counts, folded by default. `session.usage` entries between steps don't split a group.
- **Filling header:** while the last group is filling, its header shows the latest step's line and updates as steps arrive; after `finished`, it shows only `Steps (n)`.
- **Fold state survives:** open a group and a step, then send more steps; both stay open.
- **Scroll:** at the bottom, new steps keep the view at the bottom; scrolled up, it stays put.
- **Detail size:** a 5,000-character command shows 2,000 characters and a "show all"; a Write shows "+N lines" and no contents.
- **Kept:** after the Session finishes and the page reloads, the groups are still there, folded.
- **Card:** while running, the card shows the pulse and "last step …s ago" (the time advances without a new event); when paused, only Paused; when finished, nothing. Under emulated reduced motion, the dot has no animation.
- **`lastStepAt`:** through the API or `item.updated` over SSE, a progress event sets `run.lastStepAt`; a burst of steps yields at most one `item.updated` per 5 seconds and the final value is the last step's time.
- **Access:** a person who can't read the Item's Thread can't see its steps (the existing Thread access test, extended with a progress entry).
- **Phone:** at a phone viewport, folded step lines are one line high with an ellipsis and the toggles are at least 44px tall.
- **Project Thread:** steps in a Project Thread Session are grouped the same way.

## Out of Scope

- Masking secret-looking strings in steps (its own story if wanted).
- Saving fold state across views or reloads.
- Changing what the Widget emits (subagent text stays out).
- Pruning or archiving old steps.
- A stall alarm or Ask when `lastStepAt` grows old; the climbing time is the cue for now.

## Further Notes

- The 5-second throttle and the 2,000-character cut are the Spec's figures; the Builder may adjust them if the code or tests show a better fit, and should say so in its Digest.
- The verb table covers the Claude Code tools seen today. New tools fall back to name plus first string field, so nothing breaks when the tool set changes.
