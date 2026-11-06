---
title: A runaway guard of 20% of the week in any 12 hours
epic: budgets
stage: grill
blocked-by: []
---
The per-Session share of the week (`perSession.share`) kept pausing ordinary Sessions, and the person was answering its Asks every time, so it was raised from 5% to 20% as a stopgap. What the person actually wants is a guard against runaway spend across the whole Budget: if Kiln's Sessions together use more than 20% of the weekly plan within any 12 hours, the work pauses and one Ask comes up. Otherwise Kiln stays quiet and the person watches usage themselves.

Kiln measures quota per Session against the week and 5-hour windows (`packages/core/src/budgets/quota.ts`, `kinds.ts`); a rolling 12-hour Budget-scoped limit is new.

## To grill

- Rolling 12 hours (any 12-hour span) or fixed halves of the day?
- Budget-wide only, or per Project too? Does the per-Session share stay (at 20%, or off)?
- What pauses when it trips: dispatch of new Sessions only, or running ones too? One Ask, with "carry on for another N%"?
- The 20% and 12 hours as Admin settings on the Budget, with these as defaults?
- How it shows on the board: a gauge beside the week, or only when it trips?
- Readings are account-wide (the person's own use outside Kiln counts too): measure only Kiln's attributed share, or the whole reading?
