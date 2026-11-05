---
title: Add `slugify(title)`
stage: grill
---
Add `slugify(title)` in a new `src/slugify.js`, with its tests in `test/slugify.test.js`: it turns a title into a slug for a URL or a file name.

- The slug is lowercase.
- Spaces and runs of punctuation become a single dash: `slugify('Hello,  World!')` is `'hello-world'`.
- Leading and trailing dashes are trimmed: `slugify('--Hi--')` is `'hi'`.

Open questions for the grill:

1. What should happen to accented letters? Keep them (`'café'`), strip the accents (`'cafe'`), or drop them?
2. Is an empty result an error? `slugify('!!!')` leaves nothing: return `''` or throw?
