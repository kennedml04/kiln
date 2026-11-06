# 04: Shell: running card pulse and 'last step Ns ago'

**What to build:** In ItemCard.tsx, when item.run.state is 'running' and run.stage equals item.stage, show an aria-hidden pulse dot (.running-pulse) and, if run.lastStepAt is set, 'last step 12s ago' (Ns/Nm/Nh). Use one shared clock hook (useNow(1000)) for the whole board. Accessible text 'Running, last step 12s ago'. Static dot under prefers-reduced-motion. Not shown when paused, waiting or finished. Pulse without time if lastStepAt is missing. Tests: time advances with no new event; paused shows only Paused; finished shows nothing; reduced motion has no animation. Depends on the lastStepAt ticket.

**Blocked by:** None

**Status:** needs-triage
