# 05: Scheduler dispatch: Story slots, Blocked by, parking

**What to build:** Add a pure startOrder(...) function and use it in dispatchNow: started Stories (in flight or parked) in Story order, then not-started; per Story its own entry then Tickets by number; entries with no Story last in priority order. For Ticket entries, before the pool check: hold "Blocked by NN" / "Blocked by <story>/NN" if a blockedBy Ticket isn't shipped; if the Story is in flight allow while it holds fewer than max(1, poolSize-1) slots; if not in flight allow only under the per-Project limit and box cap, else hold "Waiting for a Story slot". In flight/parked/started are derived every dispatch (parked = every unshipped Ticket waiting on a person: blocking Ask, Gate decision, Your-move Stage, or blocked only by another Story's Ticket). Also dispatch on ask.created, ask.answered and any Ticket item.stage_changed. enqueue's start-at-once path applies the same check; attended start doesn't bypass the Story limit. Add SchedulerState.stories (StoryEntry) and QueueEntry.storyId. Tests 1, 4, 5, 6, 7 of the spec. Depends on tickets 01, 02, 03, 04.

**Blocked by:** None

**Status:** done

**Stage:** shipped
