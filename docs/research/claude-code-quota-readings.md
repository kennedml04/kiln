# Claude Code: where the Max plan quota readings come from

Research for ticket 03, 2026-11-02. Question: how can the Claude Code Agent Widget, wrapping the Claude Agent SDK, read the Claude Max plan's three usage windows (5-hour, weekly, Fable weekly): percent used, reset time, how fresh, and whether per model.

Sources:
- **[T]** The SDK's type definitions: `@anthropic-ai/claude-agent-sdk` 0.3.316 (bundles Claude Code 2.1.316, the same version installed here), file `sdk.d.ts`. Installed into a throwaway scratchpad folder.
- **[B]** The bundled CLI binary `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, searched for header names.
- **[SL]** Claude Code docs, status line: https://code.claude.com/docs/en/statusline
- **[C]** Claude Code docs, costs and `/usage`: https://code.claude.com/docs/en/costs
- **[O1]** Observation run 1: one prompt ("Reply with the single word: ok") on `haiku` (claude-haiku-5-5), Max login, no tools. Cost $0.0010.
- **[O2]** Observation run 2: the SDK's `/usage` control request on an open query with no prompt sent. No model call, $0.

## Verdicts

| Window | Verdict | Source Kiln can use |
| - | - | - |
| Weekly (all models) | **Reliable**, through an experimental API | `get_usage` control request: `rate_limits.seven_day` and the `limits[]` row with `kind: "weekly_all"`. Also arrives as `rate_limit_event` with `rateLimitType: "seven_day"`, but only when it changes. |
| Fable weekly | **Partial** | Only `get_usage`: `rate_limits.model_scoped[]` (`display_name: "Fable"`) and the `limits[]` row with `kind: "weekly_scoped"`, `scope.model.display_name: "Fable"`. Not in rate-limit events, headers or the status line. |
| 5-hour | **Partial** | The fields exist in all three sources (`get_usage` `five_hour`, `rate_limit_event` `five_hour`, status line `rate_limits.five_hour`), but in both observation runs a Max account had no 5-hour reading at all (`five_hour: null`, no `session` row in `limits[]`). Kiln cannot count on it being present. |

## The sources

### 1. `get_usage` control request (the data behind `/usage`): the main source
- Method on the SDK `Query`: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors?: boolean })`, returning `SDKControlGetUsageResponse`. Its doc comment: "EXPERIMENTAL: this API is unstable and may change or be removed in any release without notice ... The method name will change when the API is stabilized." [T, `Query`]
- `skipBehaviors: true` skips the scan of local transcripts, "for callers that need only the plan rate limits, such as a usage meter". [T, `SDKControlGetUsageRequest`]
- Typed shape [T]:
  - `subscription_type: string | null` (`'max'` here)
  - `rate_limits_available: boolean` (false for API key, Bedrock, Vertex, "or missing profile scope")
  - `rate_limits.five_hour | seven_day | seven_day_opus | seven_day_sonnet | seven_day_oauth_apps`: each `{ utilization: number | null /* 0-100 */, resets_at: string | null /* ISO 8601 */ } | null`
  - `rate_limits.model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[]`: "Per-model weekly windows ... Server-supplied label for the model bucket (e.g. 'Fable'). Additive: absent when nothing is known about them (an answer served from cached data, or rows the allowlist hides)".
  - `rate_limits.extra_usage`: usage credits (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `currency`).
- The structured `/usage` report type `SDKUsageReport` also documents the server's `limits[]` rows: `kind` ("e.g. 'session', 'weekly_all' or 'weekly_scoped'. Classify a row on this, never on a label"), `group`, `percent` 0-100, `resets_at`, `scope.model.display_name`, `severity`, `is_active`. [T, `SDKUsageReport`] The `get_usage` reply carried the same `limits[]` array in practice [O2].
- Observed [O2] (trimmed and with the values replaced by placeholders; the reply also held many undocumented, codenamed keys, all null or unrelated, which Kiln must ignore):
  ```json
  "subscription_type": "max", "rate_limits_available": true,
  "five_hour": null,
  "seven_day": { "utilization": 42, "resets_at": "<resets_at>" },
  "seven_day_opus": null, "seven_day_sonnet": null,
  "limits": [
    { "kind": "weekly_all", "group": "weekly", "percent": 42, "severity": "normal",
      "resets_at": "<resets_at>", "scope": null, "is_active": false },
    { "kind": "weekly_scoped", "group": "weekly", "percent": 60, "severity": "warning",
      "resets_at": "<resets_at>",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }, "is_active": true } ],
  "weekly_scoped_shares": [ { "limit_index": 1, "used_percent_of_weekly": 50, "allowance_percent_of_weekly": 50 } ],
  "model_scoped": [ { "display_name": "Fable", "utilization": 60, "resets_at": "<resets_at>" } ],
  "extra_usage": { "is_enabled": true, "monthly_limit": "<limit>", "used_credits": "<used>", "utilization": "<percent>", "currency": "USD" }
  ```
- Cost and speed: works on a query that has sent no prompt, so a reading costs no model usage. First call 778 ms; a second call straight after returned in 1 ms, so the CLI caches the reply in process (cache lifetime not documented) [O2]. If the usage endpoint is rate limited, `/usage` falls back to the last reply from the past 60 minutes and says how old it is [C]. Kiln should therefore stamp each reading with when it was taken, and not poll fast.
- Scope: the reading is account-wide. It includes the person's own interactive Claude Code, claude.ai chat and Cowork (`seven_day_breakdown` rows in [O2]), not only Kiln's Sessions.
- The 5-hour window: `five_hour` was `null` and `limits[]` had no `session` row, both right after run [O1] made a model call. Why is not documented. Either this account's plan currently has no 5-hour meter or the server omits it when it is not binding. Not settled.

### 2. `rate_limit_event` stream message: push, but partial
- `SDKRateLimitEvent { type: 'rate_limit_event'; rate_limit_info: SDKRateLimitInfo }`, doc comment "Rate limit event emitted when rate limit info changes." [T]
- `SDKRateLimitInfo`: `status: 'allowed' | 'allowed_warning' | 'rejected'`, `resetsAt?: number`, `rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage'`, `utilization?: number`, `surpassedThreshold?`, overage fields (`overageStatus`, `isUsingOverage`, `overageEnabled`, ...). No Fable type. [T]
- The CLI builds it from the API's response headers: `anthropic-ratelimit-unified-5h-utilization`, `-5h-reset`, `-7d-utilization`, `-7d-reset`, `-representative-claim`, `-overage-*` and others. No per-model header exists among them [B].
- Observed [O1], one event before the reply (values replaced by placeholders):
  ```json
  {"status":"allowed_warning","resetsAt":"<epoch seconds>","rateLimitType":"seven_day","utilization":0.42,
   "surpassedThreshold":0.25,"overageStatus":"allowed","isUsingOverage":false,"overageEnabled":true,
   "unifiedWindows":{"seven_day":{"utilization":0.42,"resetsAt":"<epoch seconds>","status":"allowed_warning","surpassedThreshold":0.25}}}
  ```
- Gotchas: `utilization` is a **fraction 0-1** here (0.42) while `get_usage` gives **0-100** (42). `resetsAt` is Unix epoch **seconds**, and matched `get_usage`'s ISO `resets_at`. The event names one window (the "representative claim"); `unifiedWindows` is undocumented and held only `seven_day`. All fields are optional, and it fires only on change, so it cannot give the start-and-end-of-Session readings the spec asks for.
- Good use: an early trigger. A new event (status change, `rejected`, `isUsingOverage: true`) should make the Widget take a fresh `get_usage` reading.

### 3. Status line input: not usable from Kiln
- `rate_limits.five_hour` and `rate_limits.seven_day`, each `used_percentage` (0-100) and `resets_at` (Unix epoch seconds). Present only for Pro, Max and Ultra subscribers and "only after the first API response in the session. Each window ... may be independently absent, and Claude Code drops a window once its `resets_at` time passes." No per-model or Fable field. Updates are event-driven and debounced at 300 ms. [SL]
- It is a command the interactive terminal UI runs. A headless SDK Session has no status line to read, and `get_usage` already carries the same numbers plus Fable. (Inference from [SL]; not tested headless.)

### 4. `/usage` command text
- The same data as `get_usage`, as text. When run in an SDK Session the assistant message may carry `usage_report: SDKUsageReport` beside the text [T]. No reason to use it over `get_usage`, which needs no turn.

### 5. Per-turn usage in results
- `SDKResultMessage` carries `total_cost_usd` and `modelUsage` (API-equivalent dollars and tokens), not plan percentages. Useful for the per-turn records and for splitting a quota change across concurrent Sessions, not as a quota reading. [T, C]

## What a Kiln Agent Widget can report

One quota reading per window, taken with `get_usage({ skipBehaviors: true })` at Session start, at Session end, every few minutes while Sessions run, and whenever a `rate_limit_event` arrives:

```ts
type QuotaReading = {
  window: "five_hour" | "weekly" | "model_weekly";
  model?: string;          // for model_weekly: limits[].scope.model.display_name, e.g. "Fable"
  percentUsed: number;     // 0-100. Multiply rate_limit_event utilization by 100.
  resetsAt: string;        // ISO 8601. Convert the event's epoch seconds.
  severity?: string;       // server's "normal" | "warning" | "critical", from limits[]
  takenAt: string;         // when the Widget read it
  source: "get_usage" | "rate_limit_event";
};
```

Mapping: `limits[].kind` `session` to `five_hour`, `weekly_all` to `weekly`, `weekly_scoped` with `scope.model` to `model_weekly` (classify on `kind`, never on the label, per [T]). Fall back to the named `five_hour` / `seven_day` / `model_scoped` fields when `limits` is null. A window with no row is reported as no reading for that window, not as 0%.

## Changes the spec needs
1. **"No readings" must be per window, not per Budget.** The spec's rule is "If an Agent reports no quota readings for a subscription Budget, the Budget shows 'unknown'". In practice the weekly and Fable windows were present while the 5-hour window was missing. Each gauge should show "unknown" on its own, and its reserve and auto-resume rules should not apply while it is unknown. The 5-hour auto-resume (user story 69) cannot be relied on.
2. **The Agent interface's quota reading event** should carry the model label for per-model windows (Fable), a `takenAt` time and a source, and fix the unit at 0-100 and ISO time (see the type above).
3. **Readings are polled, not only pushed.** The Widget polls `get_usage`; events alone fire only on change and never cover Fable. Note the dependency on an API Anthropic marks experimental. If it disappears, the weekly window falls back to `rate_limit_event` (partial) and Fable becomes unknown. `kiln doctor` should check that `get_usage` answers with `rate_limits_available: true`.
4. **Readings are account-wide.** A Session's quota cost (the change across its turns) also counts the person's own use in the same minutes. The spec's attribution should say so, or skip the change when the person has been active.
5. **Usage credits.** The account tested had usage credits on (`extra_usage.is_enabled: true`). When a window is used up, Claude Code can keep working on paid credits (`overageStatus: "allowed"`). The spec doesn't mention them. Suggest the subscription Budget treats `isUsingOverage: true` or a rising `extra_usage.used_credits` as reaching the window's limit: pause and raise an Ask rather than spend credits unattended.
6. **Fable probably draws on the weekly window too.** `weekly_scoped_shares` (undocumented) reported `used_percent_of_weekly: 50, allowance_percent_of_weekly: 50` for the Fable row. My reading, not confirmed by any doc: Fable's allowance is half the week and Fable use also counts toward the weekly gauge, so the Fable gauge is a sub-limit inside the week, not a separate pool. Confirm before the pace rule depends on it.
