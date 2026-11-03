import type { DatabaseSync } from 'node:sqlite';
import type { KilnEvent } from '@kiln/widget-sdk';

type Listener = (event: KilnEvent) => void;

/** The event bus: every state change is stored in SQLite, then pushed to subscribers. */
export interface EventBus {
  publish<P>(type: string, payload: P): KilnEvent<string, P>;
  /** Stored events with an id greater than `afterId`, oldest first. */
  since(afterId: number): KilnEvent[];
  /** Stored events whose payload has `field` equal to `value` (e.g. every event of one Item), oldest first. */
  withPayload(field: string, value: string): KilnEvent[];
  subscribe(listener: Listener): () => void;
}

export function createEventBus(db: DatabaseSync): EventBus {
  const listeners = new Set<Listener>();
  const insert = db.prepare('INSERT INTO events (type, at, payload) VALUES (?, ?, ?)');
  const select = db.prepare('SELECT id, type, at, payload FROM events WHERE id > ? ORDER BY id');
  const selectByPayload = db.prepare('SELECT id, type, at, payload FROM events WHERE json_extract(payload, ?) = ? ORDER BY id');
  type Row = { id: number; type: string; at: string; payload: string };
  const parse = (rows: Row[]) => rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));

  return {
    withPayload(field, value) {
      if (!/^\w+$/.test(field)) throw new Error(`Not a payload field: ${field}`);
      return parse(selectByPayload.all(`$.${field}`, value) as Row[]);
    },
    publish(type, payload) {
      const at = new Date().toISOString();
      const { lastInsertRowid } = insert.run(type, at, JSON.stringify(payload ?? null));
      const event = { id: Number(lastInsertRowid), type, at, payload };
      for (const listener of listeners) listener(event);
      return event;
    },
    since(afterId) {
      return (select.all(afterId) as { id: number; type: string; at: string; payload: string }[]).map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as unknown,
      }));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
