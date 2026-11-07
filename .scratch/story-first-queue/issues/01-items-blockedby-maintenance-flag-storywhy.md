# 01: Items: blockedBy, maintenance flag, storyWhy

**What to build:** Add Item.blockedBy?: string[] and Item.maintenance?: true to widget-sdk; add storyWhy(description) (first sentence, 140 chars, ellipsis) to widget-sdk. Markdown Tracker parses **Blocked by:** (None/empty = none; 03, 3, 03-slug, #3, comma/space separated; <story>/03 for another Story's Ticket; unmatched numbers ignored and reported as a Project file error) into TrackerItem.blockedByKeys, mapped to Item ids in work.ts like parentKey. Story files with `maintenance: true` set item.maintenance. Tests via API (Items) and storyWhy unit test.

**Blocked by:** None

**Status:** needs-triage
