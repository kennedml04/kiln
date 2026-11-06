# Grill: Show a running Session's steps in its Thread, folded by default

## Where things stand today

- Steps already reach the Thread. The Claude Code Widget emits `progress` events for every `tool_use` block (`{ tool: { name, input } }`) and every top-level text block (`{ text }`) (`widgets/claude-code/src/agent.ts:239`). Core stores them as `session.progress` on the bus. The Thread is every `session.*` event for the Item (`packages/core/src/flow/session-manager.ts:199`), and it streams live over SSE.
- Nothing prunes them, so they are already kept after the Session ends.
- The Shell's `ThreadLog` (`packages/shell/src/work/ItemView.tsx:79`) shows each one as a flat line: a note in full, a tool call as a bare `Tool: Read` with no input. That's why the Thread "shows little": the tool lines say nothing, and the notes aren't folded.
- A running card (`ItemCard.tsx`) shows `Paused` but nothing for running.
- Nothing redacts tool inputs anywhere.

So this story is mostly Shell work, plus one small core addition for the card.

## Decisions

1. **Which steps show: both** tool calls and the Agent's own notes (asked, answered "Both").
   - A tool call's line is a verb plus its key argument: `Read packages/core/src/cli.ts`, `Ran npm test`, `Edited ItemView.tsx`, `Searched "session.progress"`. Unknown tools fall back to the tool name plus its first string field.
   - A note's line is its first line, cut to fit.
   - Subagent tool calls show like any other step. Subagent text is already left out by the Widget, which stays as is.
2. **Folding: groups** (asked, answered "Groups with the latest step in the header").
   - A run of consecutive `session.progress` entries between other Thread entries (messages, Asks, Exit checks, Digests, Stage moves, Session start/finish) becomes one `Steps (n)` group, folded by default.
   - Opened, it lists one line per step, and each line opens again (+/-) to show the step's detail.
   - While a group is still filling (its Session is running and it is the last group), its header also shows the latest step's line, so movement shows without opening it.
   - Fold state is per view and not saved. New steps arriving don't change what the person has opened, and the existing rules still apply: keep the selection, follow the bottom only when already there.
3. **Live and kept** (asked, answered "Keep them, folded"). Steps stream live as now and stay in the Thread after the Session ends, folded. No deletion logic.
4. **Card movement: pulse plus last-step time** (asked, answered "Pulse plus last-step time").
   - While the Item's current-Stage Session is running, its card shows a pulse dot and "last step 12s ago".
   - Core adds the time of the latest step to the Item's `run` (e.g. `run.lastStepAt`), updated on each `session.progress`.
   - The Shell ticks the relative time on its own clock, so the card isn't re-sent per second. A climbing time with the pulse still on is how a stuck Session shows.
   - Not shown when paused (it already says Paused) or when finished.
   - The pulse respects `prefers-reduced-motion` (a static dot instead).
5. **Privacy and size** (asked, answered "Key fields, long values cut, no masking").
   - Steps have the same readers as the Thread, enforced by the existing Thread API. No new access rule.
   - An opened step shows its key fields (path, command, pattern, the note's full text). Long values are cut at about 2,000 characters with a "show all".
   - Write/Edit file contents show as "+N lines" (or "-N/+M"), not inline.
   - No secret masking in this story. Widget secrets never go to Claude Code Sessions. Masking secret-looking strings would be its own story if wanted.
6. **Phone layout** (from the story, not asked): the same groups, one line per step, tap to expand. Lines don't wrap when folded (they end in an ellipsis), and the tap targets are at least 44px tall.
7. **Where it applies** (default, not asked): `ThreadLog` is shared, so the Project Thread and the Scratch chat Thread get the same grouping.

## Open

- The exact verb mapping for each Claude Code tool (Read/Write/Edit/Bash/Grep/Glob/Task/WebFetch/MCP tools) is left to the Spec/Tickets.
- Whether `lastStepAt` counts notes as well as tool calls. Proposed: any `session.progress`.
