# Runaway agent session: cost analysis

One agent session on the earlier home-made board ran for about two days, resumed the same Claude Code session dozens of times, and cost far more than anything the board predicted. This note keeps the causes and what a new system should record. The raw figures and identifiers are left out.

## Root causes, ranked
1. **Subagent fan-out was the biggest share.** The session dispatched about two dozen implementation subagents, each a full multi-hour job running inside what the board priced as one card. Subagents were roughly two thirds of the cache reads and most of the output tokens.
2. **Huge context re-read every turn, on a 1M-window model.** Context grew from under 100k to over 600k tokens. An auto-compact threshold was added only after the session had started, so it never applied. Cumulative cost rose roughly with context size: cost grows with the square of session length.
3. **Model cost.** The most expensive model did most of the heavy work. The cost curve flattened as soon as the thread switched to a cheaper model with a freshly compacted context.
4. **Cache expiry and rewrites.** The thread kept a 1-hour cache. Gaps of hours between turns forced full rewrites of several hundred thousand tokens each. Smaller and less certain than 1-3.
5. **No stall or cost detection across turns.** There was no looping and no permission-denial retries. The cost was legitimate work running too long in one context, not a fault. The per-turn budget cap tripped once, but nothing limited the cumulative total of a resumed session.

## What a new system should record and do
- Per agent session id, one row per API call or turn: model, context size (input + cache read + cache write), cache-write size, cache-miss flag, output tokens, cost. Track cumulative cost per session and per card, not only per turn.
- Roll subagent costs up to their parent session and card, and tag each with its description.
- Record the idle gap before each turn so cache-expiry rewrites are visible and attributable.
- Keep a cumulative budget per session and card (warn at 50%, hard stop or ask at 100%), plus a context-size alarm (for example 300k) that forces a compact or a handover to a fresh session.
- Show a prediction as a range with an explicit kind: "one-shot" versus "interactive/long", with the estimate keyed on context size and number of planned subagents. Store the prediction, the reason for the model choice, and the units (USD API-equivalent) with each card, even when the answer is "no estimate".
- Attribute a card's cost from the session's first line, not from card start, so a card that adopts an existing thread is not undercounted.
- Store the unit label next to every number, and if plan credits are the real concern, also store the plan gauge percentages (5h/7d) at the start and end of each run.
