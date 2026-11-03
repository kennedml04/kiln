# A fresh Session per Stage, one Thread per item

The old board ruled that "a Story owns its session", so one agent session grew from grilling through review. Now each Stage starts a fresh Session running that Stage's role, seeded only with the item's artifacts (glossary, spec, tickets). The person still sees and talks to one Thread per item. We chose this because sessions that span Stages grow huge, which makes them costly to run and to resume and makes cost estimates unreliable. The artifacts each Stage writes are the handoff, so no earlier conversation needs to be carried forward.
