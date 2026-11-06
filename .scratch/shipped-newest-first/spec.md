# Spec: List Shipped recently newest first

Status: ready-for-agent

Sources: `.scratch/shipped-newest-first/story.md`, `.scratch/shipped-newest-first/grill.md` (the grill decisions of 2026-11-05/06, numbered 1–5 below as they are there), and the code as of branch `kiln/story/shipped-newest-first` (2cf45ba). The boards are `packages/shell/src/work/HomeBoard.tsx` (Home, grouped by run state) and `packages/shell/src/work/ProjectView.tsx` (a Project's board, one row of Stage columns per kind). Items are built in `packages/core/src/work/work.ts` (`toItems`, `refresh`, `moveTo`); the event log is `packages/core/src/events.ts`.

## Problem Statement

- Home's "Shipped recently" column and each Project's last-Stage columns list cards in store order, which is the Tracker's order, not the order work finished. What shipped today can sit under what shipped last month.
- Nothing on a shipped card says when it shipped.
- When Reset board (`.scratch/board-reset/spec.md`) clears old cards, nobody can tell at a glance which cards were old.

## Solution

Kiln records each Item's **ship time**: when Kiln moved it into its kind's last Stage, read from the event log. The core puts it on the Item as `shippedAt`. Both boards sort their shipped columns by it, newest at the top, and each shipped card shows its age ("2h ago") with the exact date and time on hover or long-press. Items with no recorded ship time go at the bottom, in today's order, with no age.

## User Stories

1. As a Member, Home's Shipped recently column lists cards with the most recently shipped at the top.
2. As a Member, on a Project's board, the last-Stage column of each kind row (Tickets, Stories, Epics, or whatever the Workflow has) is sorted the same way. Every other column keeps its order, and Home's Up next keeps the Scheduler's order.
3. As a Member, each card stands on its own: a shipped Ticket is not grouped under its Story. A Story ships when its last Ticket does, so it lands just above its Tickets anyway.
4. As a Member, a shipped card shows how long ago it shipped: "just now", "5m ago", "2h ago", "3d ago", and a date for old ones.
5. As a Member, hovering the age shows the exact date and time. On the phone, a long-press on it shows the same.
6. As a Member, the age stays current while the board is open, without a reload.
7. As a Member, a card that ships while I watch moves to the top of the column, with its age.
8. As a Member, an Item that was reworked and shipped again shows its latest ship time.
9. As a Member, an Item moved into Shipped by hand in the Tracker, or shipped before Kiln kept an event log, sits at the bottom of the column with no age. Nothing about it is guessed.
10. As a Member, the order and ages are the same on desktop and on the phone.
11. As the owner, Reset board is unchanged: archived Items stay hidden, and this Story only orders what is shown.

## Implementation Decisions

### The ship time (decisions 1 and 2)

- **Definition.** An Item's ship time is the `at` of the latest `item.stage_changed` event for that Item whose `to` is the last Stage of the Item's kind in its Project's current Workflow. Nothing else counts: not the merge commit time, not the Tracker's git history, not a file time.
- **Only while shipped.** `shippedAt` is set only when the Item's `runState` is `shipped`. An Item that leaves Shipped (rework, a Tracker edit) loses it; if it ships again through Kiln, the new event gives the new time.
- **A known gap.** If an Item shipped through Kiln, was reopened, and was then moved back into Shipped by hand, the latest matching event is the old one, so it shows the old time. That is acceptable: Kiln has no record of the hand move.
- **Ties.** Two Items with the same `at` keep their current relative order (stable sort).

### Core

- `Item` in `packages/widget-sdk/src/work.ts` gains `shippedAt?: string` (ISO 8601, the event's `at`), documented as "When Kiln moved the Item into its kind's last Stage. Unset when it is not shipped, or Kiln has no record of it."
- **Cache in Work.** `createWork` keeps a map `itemId → Map<stageId, at>` of the latest `item.stage_changed` time per Item and target Stage. It is loaded once at start with one query over the `events` table (`type = 'item.stage_changed'`, grouped by `json_extract(payload, '$.itemId')` and `json_extract(payload, '$.to')`, `MAX(at)`), not one `withPayload` query per Item. Work subscribes to the bus and updates the map on each `item.stage_changed`.
- **Filling the field.** `toItems` (and so every `refresh`) sets `shippedAt` from the map when `runStateOf` gives `shipped`, using the last Stage id of the Item's kind. `remark` keeps it consistent when it recomputes run state.
- **Order of events in `moveTo`.** Today `moveTo` refreshes the Item (which publishes `item.updated` with the new Stage) and only then publishes `item.stage_changed`. So the refresh can't see the new time yet. After publishing `item.stage_changed`, Work updates the map, sets `shippedAt` on the stored Item, and publishes `item.updated` for it when the field changed. The Shell then gets the time with no new event handling. Roll-ups ship Stories and Epics through `advance`, which is `moveTo`, so they are covered.
- **Workflow changes.** If a Project's Workflow changes so the last Stage id changes, the next refresh recomputes `shippedAt` against the new last Stage. Items with no event into the new last Stage have none.
- Nothing else reads `shippedAt`: the Scheduler, roll-ups, Exits and Reset board are unchanged.

### Shell: sorting (decisions 3 and 5)

- A small shared helper (for example `packages/shell/src/work/shipped.ts`) exports `byShippedNewest(items: Item[]): Item[]`: Items with `shippedAt` first, newest first by the timestamp; then Items without it, in the order given. It is a stable sort.
- `HomeBoard` applies it to the `shipped` group in its `columns` memo, beside the Up next sort.
- `ProjectView` applies it to the last-Stage column of each kind row only.
- Every card stands alone; no grouping by parent is added.

### Shell: the age on the card (decision 4)

- `ItemCard` shows the age when `item.runState === 'shipped'` and `item.shippedAt` is set, as a `<time dateTime={shippedAt} title={exact}>` element. The `title` is the exact local date and time (for example `toLocaleString()` with date and time). On the phone, a long-press on the element shows the same text (the `title`, or a small popover if the browser shows no tooltip on touch).
- **Wording**, from now minus `shippedAt`:
  - under 1 minute: "just now" (also for a time slightly in the future, from clock skew);
  - under 1 hour: "Nm ago";
  - under 1 day: "Nh ago";
  - under 30 days: "Nd ago";
  - older: the date, "Mar 4", with the year added if it isn't this year ("Mar 4, 2025").
- One formatting function, `shippedAge(at: string, now: number): string`, in the same helper file, so it is easy to test.
- **Staying fresh.** A single shared clock (a hook such as `useMinuteClock()`) ticks once a minute while a board is mounted, and the age re-renders from it. `ItemCard` is memoised; the clock must reach only shipped cards' age element (for example a small `ShippedAge` component that uses the hook), not re-render every card.
- The age is quiet text in the card's meta line, in the existing dark-first theme. It doesn't push other card content off on the phone.

## Testing Decisions

All core tests drive Kiln from outside with `startTestKiln(t)` and `kiln.installFakeAgent({ script })`, checking API responses and SSE events.

- **Ship time set:** a Ticket that ships through its Gate has `shippedAt` in `GET` Items and in an `item.updated` event, equal to the `at` of its `item.stage_changed` into the last Stage. A Story shipped by roll-up gets its own `shippedAt`.
- **Not shipped:** live Items have no `shippedAt`.
- **Rework:** a shipped Item sent back loses `shippedAt`; shipped again, it has the new, later time.
- **No record:** an Item moved into its last Stage by a Tracker edit in the temp repo is shipped with no `shippedAt`.
- **Restart:** after a core restart (same data folder), shipped Items keep the same `shippedAt` from the event log.
- **Shell unit tests** (`node --test`, no browser): `byShippedNewest` orders by time, puts Items without a time last in their given order, and is stable on ties. `shippedAge` gives each wording band, including "just now" for a future time and the year rule.
- **Shell (Playwright):** on Home and on a Project's board, at desktop and phone width, with Items shipped in a known order: the Shipped column lists them newest first, an Item with no time is last, each shipped card shows its age with the exact time in `title`, and other columns are unchanged. A newly shipped Item appears at the top while the page is open.

## Out of Scope

- Grouping Tickets under their Story in Shipped.
- Reading ship times from git history, merge commits or the Tracker.
- Showing ship time on Items outside the boards' shipped columns (the Item page, Shipped history). A later Story can reuse `shippedAt`.
- Any change to Reset board, archiving or an age-based cut-off.
- Sorting any other column.

## Further Notes

- **Related Stories.** "A cut-off for Shipped recently" is absorbed by Reset board (board-reset grill, decision 6). With newest first, the cards Reset removes are the old ones at the bottom.
- **Glossary.** The first Ticket adds to `GLOSSARY.md`: **Ship time**: when Kiln moved an Item into its kind's last Stage, from the event log. _Avoid_: merge time.
- **Suggested ticket order:**
  1. Core: `Item.shippedAt`, the event-log cache in Work, filling it in `toItems`, `remark` and after `moveTo`, with the core tests. Glossary term.
  2. Shell: `byShippedNewest` on both boards, the age on shipped cards with the minute clock, unit and Playwright tests.
