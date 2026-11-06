// The Shell's one client-side store, fed by one SSE stream per browser.
// Components read slices with `useStore(selector)` and re-render only when their slice changes.
// Events patch only what they name, so unchanged Items keep the same object and don't re-render.
import { useSyncExternalStore } from 'react';
import { needsYouOrder } from '@kiln/widget-sdk';
import type {
  Ask,
  AskAnsweredEvent,
  AskRaisedEvent,
  AskUpdatedEvent,
  AsksSnapshotEvent,
  BudgetInfo,
  BudgetsUpdatedEvent,
  Item,
  ItemCreatedEvent,
  ItemRemovedEvent,
  ItemUpdatedEvent,
  KilnEvent,
  Me,
  PanelView,
  Project,
  ProjectRegisteredEvent,
  ProjectRemovedEvent,
  ProjectUpdatedEvent,
  SchedulerState,
  SchedulerUpdatedEvent,
  ThreadEntry,
  WorkSnapshotEvent,
} from '@kiln/widget-sdk';

import { api } from './api.ts';

/** Calls the core API with the CSRF token (see api.ts). */
export { api };

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface ShellState {
  connection: ConnectionState;
  lastEvent?: KilnEvent;
  /** Who this browser is (GET /api/me), once known. */
  me?: Me;
  projects: Record<string, Project>;
  items: Record<string, Item>;
  /** Thread entries per Item id, in event order: what the Item view loaded plus live events. */
  threads: Record<string, ThreadEntry[]>;
  /** Open Asks (Needs you), by id. */
  asks: Record<string, Ask>;
  /** Running Widgets' panels, by `widgetId/panelId`. */
  panels: Record<string, PanelView>;
  /** Pools, the Up next order and whether Stop all is on; sent on connect and on every change. */
  scheduler?: SchedulerState;
  /** Budgets with their header gauges; sent on connect and whenever usage or settings change. */
  budgets: BudgetInfo[];
}

let state: ShellState = { connection: 'connecting', projects: {}, items: {}, threads: {}, asks: {}, panels: {}, budgets: [] };
const listeners = new Set<() => void>();

const update = (patch: Partial<ShellState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useStore<T>(selector: (s: ShellState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const setMe = (me: Me) => update({ me });

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

/** Open Asks in Needs you order: most work blocked first, then oldest. */
export const openAsks = (asks: Record<string, Ask>): Ask[] => Object.values(asks).sort(needsYouOrder);

/** Puts an Ask in the store, or takes it out once it is no longer open. */
function putAsk(ask: Ask, lastEvent?: KilnEvent) {
  const { [ask.id]: _old, ...rest } = state.asks;
  update({ asks: ask.state === 'open' ? { ...rest, [ask.id]: ask } : rest, ...(lastEvent ? { lastEvent } : {}) });
}

/** Events that are lines in an Item's Thread (the same set the core's thread route returns). */
const THREAD_EVENT = /^(session\.|exit\.checked$|digest\.written$|item\.stage_changed$|item\.from_chat$)/;

/** Adds Thread entries for one Item, skipping ones it already has (by event id) and keeping event order. */
export function addThreadEntries(itemId: string, entries: ThreadEntry[], lastEvent?: KilnEvent) {
  const current = state.threads[itemId] ?? [];
  const seen = new Set(current.map((e) => e.id));
  const fresh = entries.filter((e) => !seen.has(e.id));
  if (fresh.length === 0 && current.length > 0) return lastEvent ? update({ lastEvent }) : undefined;
  const merged = [...current, ...fresh].sort((a, b) => a.id - b.id);
  update({ threads: { ...state.threads, [itemId]: merged }, ...(lastEvent ? { lastEvent } : {}) });
}

export const panelKey = (p: { widgetId: string; panelId: string }) => `${p.widgetId}/${p.panelId}`;

/** Reloads every panel (on connect and when a Widget comes up). */
async function loadPanels() {
  try {
    const list = await api<PanelView[]>('GET', '/api/panels');
    update({ panels: Object.fromEntries(list.map((p) => [panelKey(p), p])) });
  } catch {
    // Not allowed or not reachable: keep what we have; the next connect tries again.
  }
}

type PageMessage = { widgetId: string; panelId: string; message: unknown };
const pageListeners = new Set<(m: PageMessage) => void>();

/** Follows messages Widgets send their embedded pages. */
export function onPageMessage(listener: (m: PageMessage) => void): () => void {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
}

/** Applies one event to the store. Work events patch one entry; the snapshot replaces Work state. */
function apply(event: KilnEvent) {
  switch (event.type) {
    case 'widget.ready':
      void loadPanels();
      return update({ lastEvent: event });
    case 'widget.panel_updated': {
      const { panel } = event.payload as { panel: PanelView };
      return update({ panels: { ...state.panels, [panelKey(panel)]: panel }, lastEvent: event });
    }
    case 'widget.page_message':
      for (const listener of pageListeners) listener(event.payload as PageMessage);
      return;
    case 'widget.stopped':
    case 'widget.exited':
    case 'widget.removed': {
      const { widgetId } = event.payload as { widgetId: string };
      const panels = Object.fromEntries(Object.entries(state.panels).filter(([, p]) => p.widgetId !== widgetId));
      return update({ panels, lastEvent: event });
    }
    case 'work.snapshot': {
      const { projects, items } = (event as WorkSnapshotEvent).payload;
      return update({ projects: byId(projects), items: byId(items) });
    }
    case 'project.registered':
    case 'project.updated': {
      const { project } = (event as ProjectRegisteredEvent | ProjectUpdatedEvent).payload;
      return update({ projects: { ...state.projects, [project.id]: project }, lastEvent: event });
    }
    case 'project.removed': {
      const { projectId } = (event as ProjectRemovedEvent).payload;
      const { [projectId]: _removed, ...projects } = state.projects;
      const items = Object.fromEntries(Object.entries(state.items).filter(([, i]) => i.projectId !== projectId));
      return update({ projects, items, lastEvent: event });
    }
    case 'item.created':
    case 'item.updated': {
      const { item } = (event as ItemCreatedEvent | ItemUpdatedEvent).payload;
      return update({ items: { ...state.items, [item.id]: item }, lastEvent: event });
    }
    case 'item.removed': {
      const { [(event as ItemRemovedEvent).payload.id]: _removed, ...items } = state.items;
      return update({ items, lastEvent: event });
    }
    case 'asks.snapshot':
      return update({ asks: byId((event as AsksSnapshotEvent).payload.asks) });
    case 'ask.raised':
    case 'ask.updated':
    case 'ask.answered':
      return putAsk((event as AskRaisedEvent | AskUpdatedEvent | AskAnsweredEvent).payload.ask, event);
    case 'scheduler.updated':
      return update({ scheduler: (event as SchedulerUpdatedEvent).payload, ...(event.id ? { lastEvent: event } : {}) });
    case 'budgets.updated':
      return update({ budgets: (event as BudgetsUpdatedEvent).payload.budgets });
    case 'core.hello':
      void loadPanels();
      return;
    default:
      if (THREAD_EVENT.test(event.type)) {
        const entry = event as ThreadEntry;
        return addThreadEntries(entry.payload.itemId, [entry], event);
      }
      update({ lastEvent: event });
  }
}

/** Opens the event stream. EventSource reconnects by itself and resends Last-Event-ID. */
export function connect(url = '/api/events'): () => void {
  const source = new EventSource(url);
  source.onopen = () => update({ connection: 'connected' });
  source.onerror = () => update({ connection: 'disconnected' });
  source.onmessage = (message: MessageEvent<string>) => apply(JSON.parse(message.data) as KilnEvent);
  return () => source.close();
}
