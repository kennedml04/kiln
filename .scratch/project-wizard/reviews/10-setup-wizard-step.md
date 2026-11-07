# Review: 10, The setup wizard's Project step

Reviewed commit 8f6884a against `issues/10-setup-wizard-step.md` and user story 1 in `spec.md`.

**Verdict: approve.** Nothing blocks shipping. There are three small nits below, and none of them needs a fix before it ships.

## Acceptance criteria

- [x] **The wizard's last step can create a new Project, import a folder, or import from the old board's list.** `ProjectStep` (`packages/shell/src/SetupWizard.tsx`) has three radio choices: New, Import and From the old board. New and Import render the same components as + Project. `ImportProject` was moved out of `HomeBoard.tsx` into `work/ImportProject.tsx` unchanged, so the board and the wizard share one form. `NewProject` gained a `stay` prop, so the wizard stays put instead of opening the new Story. The old board's list is the existing `ImportStep`, with its `<Step>` wrapper swapped for a group.
- [x] **The dev instance still shows the Demo step.** `DEV_STEPS` now filters out `'Project'` where it used to filter out `'Import'`. The dev-instance tests pass, including the renamed "has no Project step: it ends with Demo".
- [x] **Setup wizard tests cover all three choices.** The first wizard test now picks "From the old board" before it imports. A new test makes a Project with New, checks that the wizard stays on the Project step and the Project exists, then registers a temp repo with Import and finishes.

## Checks run

- `npm run check`, `npm run build` and `npm run typecheck` all pass.
- `packages/shell/test/setup-wizard.test.ts`: 9 of 9 pass.
- `project-new`, `project-import` and `import-scan` tests: 10 of 10 pass. These cover the board's + Project after the refactor.

## Nits (non-blocking)

1. **A stale comment.** `SetupWizard.tsx:665` still says "a dev instance has no Import step"; it should say "Project step". The comment at `setup-wizard.test.ts:25` refers to "the Import step" too, which now means the old-board choice.
2. **Switching choices drops what was typed.** Each choice mounts its own form, so typing a name under New and then clicking Import (or the reverse) clears it. That's acceptable for a radio choice. Keeping the forms mounted and hiding them would keep the text, if anyone minds.
3. **The new test's Import assertions are loose.** It waits for `/^Added (?!desk-bracket)/` and checks there are 2 Projects. Asserting the imported repo's name, and that New made its "What we're building" Story, would pin the test down more. `project-new.test.ts` already covers the Story.

## Notes

- Staying in the wizard after New, instead of opening the grill Story the way + Project does, is reasonable: Finish takes the person to the board, where the Story is waiting. The `stay` prop records this choice.
- A successful New or Import calls the wizard's `refresh()`. `ProjectStep` isn't keyed on setup state, so the refresh doesn't reset the step's choice or the "Added …" status.
