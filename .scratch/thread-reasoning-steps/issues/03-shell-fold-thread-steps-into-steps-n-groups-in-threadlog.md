# 03: Shell: fold Thread steps into 'Steps (n)' groups in ThreadLog

**What to build:** In ThreadLog (packages/shell/src/work/ItemView.tsx) group consecutive session.progress entries into one folded 'Steps (n)' group (usage/quota entries sit inside, uncounted; any other entry ends the group). Opened: one line per step, each a button[aria-expanded] opening its detail (definition list, pre for commands/notes, 2,000-char cut with 'show all'); no toggle for one-line notes. The last group shows the latest step in its header (aria-live off). Fold state is component state keyed by first entry id, kept as steps arrive; keep selection and bottom-follow rules (scroll effect keyed on last entry id). Phone: nowrap ellipsis lines, 44px targets, pre scrolls sideways. Applies to the Project Thread too; note in the Digest whether Scratch chat is on ThreadLog. Tests via startTestKiln/openShell with the fake Agent covering lines, grouping, filling header, fold persistence, scroll, size cut, kept after finish and reload, access, phone and Project Thread. Depends on the steps.ts ticket.

**Blocked by:** None

**Status:** in-review

**Stage:** review
