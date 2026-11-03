// Core events a Widget can subscribe to: `GET /api/widget/events?types=a,b` with its credential,
// an SSE stream of KilnEvent (same format as `GET /api/events`; send `last-event-id` to replay).
//
// A type is exact (`item.stage_changed`) or a family (`session.*`). What a Widget may follow:
// - Work events (Item moved Stage, Item changes, Session started/updated/paused/finished, usage,
//   Exit checks, Asks raised or answered): only with a `needs.work` grant, and only for the
//   Projects it covers (an event with no Project needs a grant for all Projects).
// - Widget health (started, ready, stopped, exited, restarting, unhealthy): every Widget.
// Anything else (audit, users, Org Policy, panels, raw `agent.*`) can't be subscribed to.
// Asking for a type it may not follow is refused with 403 `reason: 'grant'` and audited.

/** Families of Work events, each `<family>.<name>`, plus `exit.checked`. */
export const WORK_EVENT_FAMILIES = ['item', 'session', 'ask', 'usage'] as const;

/** Widget health events, open to every Widget. */
export const WIDGET_HEALTH_EVENTS = [
  'widget.started',
  'widget.registered',
  'widget.ready',
  'widget.stopped',
  'widget.exited',
  'widget.restarting',
  'widget.unhealthy',
] as const;

/** Which grant an event type falls under, or null when Widgets can't subscribe to it at all. */
export function widgetEventScope(type: string): 'work' | 'health' | null {
  if (type === 'exit.checked') return 'work';
  const [family, name] = type.split('.');
  if (name && /^[a-z_]+$/.test(name) && (WORK_EVENT_FAMILIES as readonly string[]).includes(family!)) return 'work';
  if ((WIDGET_HEALTH_EVENTS as readonly string[]).includes(type)) return 'health';
  return null;
}

/** The Project an event is about: `payload.projectId`, or the Item's in `payload.item`. */
export function eventProject(payload: unknown): string | undefined {
  const p = payload as { projectId?: unknown; item?: { projectId?: unknown } } | null;
  const id = p?.projectId ?? p?.item?.projectId;
  return typeof id === 'string' ? id : undefined;
}
