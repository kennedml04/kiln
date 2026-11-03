import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Actor, AuditEntry, AuditQuery } from '@kiln/widget-sdk';

export type AuditRecord = Omit<AuditEntry, 'id' | 'at'>;

/** The append-only audit log. Every change, and every refused request, is one entry with its actor. */
export interface AuditLog {
  record(entry: AuditRecord): AuditEntry;
  query(filter?: AuditQuery): AuditEntry[];
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface Row {
  id: number;
  at: string;
  actor: string;
  action: string;
  method: string | null;
  path: string | null;
  target: string | null;
  outcome: AuditEntry['outcome'];
  status: number | null;
  reason: string | null;
  detail: string | null;
}

const actorId = (actor: Actor): string | null => (actor.kind === 'kiln' ? null : actor.id);

export function createAuditLog(db: DatabaseSync): AuditLog {
  const insert = db.prepare(
    `INSERT INTO audit_log (at, actor_kind, actor_id, actor, action, method, path, target, outcome, status, reason, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    record(entry) {
      const at = new Date().toISOString();
      const { lastInsertRowid } = insert.run(
        at,
        entry.actor.kind,
        actorId(entry.actor),
        JSON.stringify(entry.actor),
        entry.action,
        entry.method ?? null,
        entry.path ?? null,
        entry.target ?? null,
        entry.outcome,
        entry.status ?? null,
        entry.reason ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
      );
      return { id: Number(lastInsertRowid), at, ...entry };
    },

    query(filter = {}) {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      const add = (clause: string, value: SQLInputValue | undefined) => {
        if (value === undefined || value === '') return;
        where.push(clause);
        params.push(value);
      };
      add('actor_kind = ?', filter.actorKind);
      add('actor_id = ?', filter.actorId);
      add("action LIKE ? ESCAPE '\\'", filter.action === undefined ? undefined : `%${filter.action.replace(/[\\%_]/g, '\\$&')}%`);
      add('outcome = ?', filter.outcome);
      add('at >= ?', filter.since);
      add('at <= ?', filter.until);
      const limit = Math.min(Math.max(Math.trunc(filter.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
      return (db.prepare(sql).all(...params) as unknown as Row[]).map((row) => {
        const entry: AuditEntry = { id: row.id, at: row.at, actor: JSON.parse(row.actor) as Actor, action: row.action, outcome: row.outcome };
        if (row.method !== null) entry.method = row.method;
        if (row.path !== null) entry.path = row.path;
        if (row.target !== null) entry.target = row.target;
        if (row.status !== null) entry.status = row.status;
        if (row.reason !== null) entry.reason = row.reason;
        if (row.detail !== null) entry.detail = JSON.parse(row.detail) as unknown;
        return entry;
      });
    },
  };
}
