// The core's clock for usage and Budget periods (days, weeks, months). A live core follows the
// system clock. A test instance's clock can be set or moved forward through `POST /api/test/clock`,
// which exists only in test mode, so roll-overs are testable without waiting.

export interface Clock {
  now(): Date;
  /** Test mode only: sets the time (it then runs on from there) or moves it forward. */
  set(change: { now?: string; advanceMs?: number }): Date;
  /** Called after every `set`. Returns an unsubscribe function. */
  onChange(listener: (now: Date) => void): () => void;
}

export function createClock(): Clock {
  let offsetMs = 0;
  const listeners = new Set<(now: Date) => void>();
  const now = () => new Date(Date.now() + offsetMs);
  return {
    now,
    set(change) {
      if (change.now !== undefined) {
        const target = Date.parse(change.now);
        if (Number.isNaN(target)) throw new RangeError(`"${change.now}" is not a time`);
        offsetMs = target - Date.now();
      }
      if (change.advanceMs !== undefined) {
        if (!Number.isFinite(change.advanceMs) || change.advanceMs < 0) throw new RangeError('"advanceMs" must be zero or more');
        offsetMs += change.advanceMs;
      }
      const at = now();
      for (const listener of listeners) listener(at);
      return at;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
