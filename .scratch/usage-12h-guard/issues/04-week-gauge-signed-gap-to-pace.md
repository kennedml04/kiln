# 04: Week gauge signed gap to pace

**What to build:** In quota.ts week window state, label becomes 'Week: 22% used · 18 under pace, resets in …' / '+6 over pace' / 'on pace' (gap = round(percent - elapsed)); add signed paceGap to QuotaWindowState. In Usage.tsx WindowGauges add the warn class on the week window when paceGap > 0. Pace hold behaviour (paceAhead) unchanged. Shell test for under- and over-pace labels and warning colour.

**Blocked by:** None

**Status:** done

**Stage:** shipped
