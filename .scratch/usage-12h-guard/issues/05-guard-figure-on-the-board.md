# 05: Guard figure on the board

**What to build:** Add guard {used, limit, left, hours, warn, tripped, askId, label} (null when guard.share 0) to the subscription BudgetInfo/rollup from GET /api/budgets, pushed on the same events as the gauges. In Usage.tsx show a budget-guard span after the week window: meter + 'Kiln, last 12h: 6% of 20 · 14 left'; class warn within 5 points, class alarm with a link to the Ask when tripped; add the alarm colour to styles.css (dark theme first) if missing. Shell tests for the figure, warning and alarm states. Depends on the guard rule ticket.

**Blocked by:** None

**Status:** needs-triage
