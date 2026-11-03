// The request bridge to Tracker and pull-request Widgets: the core sends a `widget.request` down a
// Widget's command stream and waits for its reply on POST /api/widget/replies.
import { randomUUID } from 'node:crypto';
import type { WidgetInfo, WidgetReply, WidgetRequestOp } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { WidgetHostError, type WidgetHost } from '../widget-host.ts';

const REQUEST_TIMEOUT_MS = 30_000;

/** What a Widget's Manifest provides that the bridge serves. */
export type Provision = 'trackers' | 'pullRequests';

export interface WidgetBridge {
  /** The ready Widget that provides this Tracker (or pull-request host), if one does. */
  provider(provision: Provision, id: string): string | undefined;
  /** Asks a Widget and waits for its answer; rejects with its error, or after 30 s. */
  request<T>(widgetId: string, op: WidgetRequestOp, payload: unknown): Promise<T>;
  /** A Widget's answer to one of its requests. A reply to someone else's request is refused. */
  reply(widgetId: string, reply: WidgetReply): void;
  /** A Widget said a Project's records may have changed. */
  changed(widgetId: string, projectId: string): void;
  /**
   * Calls `listener` with a Project id when its records may have changed, or with no id when a
   * Tracker Widget became ready (every Project it keeps should read again). Returns an unsubscribe.
   */
  onChanged(listener: (projectId?: string) => void): () => void;
}

interface Pending {
  widgetId: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createWidgetBridge({ bus, host, widgets }: { bus: EventBus; host: WidgetHost; widgets: () => WidgetInfo[] }): WidgetBridge {
  const pending = new Map<string, Pending>();
  const listeners = new Set<(projectId?: string) => void>();
  const notify = (projectId?: string) => {
    for (const listener of listeners) listener(projectId);
  };

  bus.subscribe((event) => {
    if (event.type !== 'widget.ready') return;
    const id = (event.payload as { widgetId: string }).widgetId;
    if (widgets().find((w) => w.id === id)?.manifest.provides?.trackers?.length) notify();
  });
  // A Widget that goes away never answers what it was asked.
  host.onExit((id) => {
    for (const [requestId, p] of pending) {
      if (p.widgetId !== id) continue;
      pending.delete(requestId);
      clearTimeout(p.timer);
      p.reject(new Error(`The ${id} Widget stopped before it answered`));
    }
  });

  return {
    provider(provision, id) {
      return widgets().find((w) => w.state === 'ready' && w.manifest.provides?.[provision]?.includes(id))?.id;
    },
    request<T>(widgetId: string, op: WidgetRequestOp, payload: unknown) {
      const requestId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`The ${widgetId} Widget did not answer ${op} within ${REQUEST_TIMEOUT_MS / 1000} s`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(requestId, { widgetId, resolve: resolve as (value: unknown) => void, reject, timer });
        try {
          host.sendCommand(widgetId, { type: 'widget.request', requestId, op, payload });
        } catch (err) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    reply(widgetId, reply) {
      const p = pending.get(String(reply?.requestId ?? ''));
      if (!p || p.widgetId !== widgetId) throw new WidgetHostError(404, 'No request of this Widget is waiting for that reply');
      pending.delete(reply.requestId);
      clearTimeout(p.timer);
      if (typeof reply.error === 'string') p.reject(new Error(reply.error));
      else p.resolve(reply.result);
    },
    changed(_widgetId, projectId) {
      notify(projectId);
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
