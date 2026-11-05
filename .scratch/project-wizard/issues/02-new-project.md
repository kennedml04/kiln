# 02: + Project → New (no modules yet)

**What to build:** A **Projects folder** core Setting with no default; the wizard asks for it the first time New is used. `POST /api/projects/new` (Admin-only) takes a name and a one-line description. It then:
1. makes `<Projects folder>\<name>`;
2. writes a README, `.kiln/settings.json` and a `.gitignore`;
3. runs `git init -b main` and commits once as the install's git identity (the one Kiln commits Tracker records as);
4. registers the Project;
5. creates a grill-stage Story "What we're building" through the Tracker, seeded with the description.

A step that fails names itself and leaves the folder in place, unregistered, so a retry continues from there. + Project gets **New** next to Import. Modules come in 08. User stories 1, 3 and 4 in `spec.md`.

**Blocked by:** 01

**Status:** done

- [x] New makes the folder, the first commit and the Project, and opens the "What we're building" Story at grill (test on a temp Projects folder)
- [x] The first commit has no attribution trailer and uses the install's git identity
- [x] A failure partway names the step, and a retry finishes the job
- [x] The Projects folder is asked for once and then remembered
