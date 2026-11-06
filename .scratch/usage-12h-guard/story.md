---
title: A runaway guard of 20% of the week in any 12 hours
epic: budgets
stage: tickets
blocked-by: []
---
The per-Session share of the week (`perSession.share`) kept pausing ordinary Sessions, and the person was answering its Asks every time, so it was raised from 5% to 20% as a stopgap. What the person actually wants is a guard against runaway spend across the whole Budget: if Kiln's Sessions together use more than 20% of the weekly plan within any 12 hours, the work pauses and one Ask comes up. Otherwise Kiln stays quiet and the person watches usage themselves.

**The per-Session share check is wrong today.** On 2026-11-05 it asked "Session share of the week reached (22 of 20 % of week)" on a fix-round Session when the whole account's week reading was 22%: it compares the account-wide week total, not what that Session used. Raised to 100 (off in effect) until this Story ships. The guard must measure the use Kiln's Sessions actually caused (a reading delta per Session, summed over the 12 hours), and a test must show a Session that used little never trips it however high the week total is.

Kiln measures quota per Session against the week and 5-hour windows (`packages/core/src/budgets/quota.ts`, `kinds.ts`); a rolling 12-hour Budget-scoped limit is new.

## To grill

- Rolling 12 hours (any 12-hour span) or fixed halves of the day?
- Budget-wide only, or per Project too? Does the per-Session share stay (at 20%, or off)?
- What pauses when it trips: dispatch of new Sessions only, or running ones too? One Ask, with "carry on for another N%"?
- The 20% and 12 hours as Admin settings on the Budget, with these as defaults?
- How it shows on the board: a gauge beside the week, or only when it trips?
- The week gauge shows the gap to pace as a signed number ("22% used · 18 under pace", "+6 over pace" in a warning colour), so the person needn't subtract; the hold rule trips at `paceAhead` over. Same treatment for the 12-hour figure?
- Readings are account-wide (the person's own use outside Kiln counts too): measure only Kiln's attributed share, or the whole reading?
