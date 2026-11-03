// "Restart when idle": a person's action (Admin, from the Shell or `kiln restart`). Kiln waits until
// no Session is running, then restarts itself. While it waits, no new Session starts, so the wait
// ends. Agents and Widgets can't ask for it: the route is Admin-only, and Widget grants never cover it.
import type { RestartPending } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';

export interface RestartWhenIdle {
  /** Asks for a restart. Restarts at once when nothing runs; otherwise waits. */
  request(): RestartPending;
  /** Calls off a pending restart. Returns false when none was pending. */
  cancel(): boolean;
  pending(): RestartPending | undefined;
  /** Why a new Session may not start now, or undefined when it may. */
  blocksSessions(): string | undefined;
  close(): void;
}

export interface RestartDeps {
  bus: EventBus;
  /** How many Sessions are running right now. */
  runningSessions(): number;
  /** Stops this core and starts a fresh one in its place (see main.ts). */
  restart(): void;
}

/** Events after which the running-Session count may have dropped. */
const SESSION_EVENT = /^session\./;

export function createRestartWhenIdle({ bus, runningSessions, restart }: RestartDeps): RestartWhenIdle {
  let requestedAt: string | undefined;
  let restarting = false;

  const pending = (): RestartPending | undefined =>
    requestedAt === undefined ? undefined : { requestedAt, runningSessions: runningSessions() };

  const restartIfIdle = () => {
    if (requestedAt === undefined || restarting || runningSessions() > 0) return;
    restarting = true;
    bus.publish('core.restarting', { requestedAt });
    // Let the reply and the event go out first.
    setImmediate(restart);
  };

  const unsubscribe = bus.subscribe((event) => {
    if (SESSION_EVENT.test(event.type)) restartIfIdle();
  });

  return {
    request() {
      requestedAt ??= new Date().toISOString();
      const state = pending()!;
      bus.publish('core.restart_pending', state);
      restartIfIdle();
      return state;
    },
    cancel() {
      if (requestedAt === undefined || restarting) return false;
      bus.publish('core.restart_cancelled', { requestedAt });
      requestedAt = undefined;
      return true;
    },
    pending,
    // The scheduler matches "waiting to restart" to keep Up next entries in place: keep the wording.
    blocksSessions: () =>
      requestedAt === undefined ? undefined : 'Kiln is waiting to restart when idle, so no new Session starts until it has restarted',
    close: unsubscribe,
  };
}
