import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB_FILE = 'kiln.sqlite';

/**
 * Ordered schema migrations. Append only: never edit or reorder a shipped entry.
 * `PRAGMA user_version` records how many have been applied.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     type TEXT NOT NULL,
     at TEXT NOT NULL,
     payload TEXT NOT NULL
   )`,
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     tracker TEXT NOT NULL,
     workflow TEXT NOT NULL,
     registered_at TEXT NOT NULL
   )`,
  // Identity and audit (ticket 11). The audit log is append-only: triggers refuse UPDATE and DELETE.
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     name TEXT,
     role TEXT CHECK (role IN ('admin', 'member', 'viewer')),
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL
   );
   CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor_kind TEXT NOT NULL,
     actor_id TEXT,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     method TEXT,
     path TEXT,
     target TEXT,
     outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'refused', 'failed')),
     status INTEGER,
     reason TEXT,
     detail TEXT
   );
   CREATE INDEX audit_log_at ON audit_log (at);
   CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
   CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;`,
  // Sessions (ticket 05).
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     stage TEXT NOT NULL,
     role TEXT NOT NULL,
     agent_id TEXT NOT NULL,
     widget_id TEXT NOT NULL,
     worktree TEXT,
     branch TEXT,
     base TEXT,
     state TEXT NOT NULL,
     exit TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT
   );
   CREATE INDEX sessions_item ON sessions (item_id)`,
  // Widget installs and grants (ticket 19). `record` is the install as JSON (manifest, pin, grants,
  // pending update). The Org Policy is key/value JSON until ticket 12 gives it a fuller shape.
  `CREATE TABLE widget_installs (
     id TEXT PRIMARY KEY,
     record TEXT NOT NULL
   );
   CREATE TABLE org_policy (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // Scheduler (ticket 14): pool sizes set by an Admin, the queue (Up next) and the Stop all flag.
  `CREATE TABLE pools (
     name TEXT PRIMARY KEY,
     size INTEGER NOT NULL
   );
   CREATE TABLE queue (
     item_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     stage TEXT NOT NULL,
     pool TEXT NOT NULL,
     priority INTEGER NOT NULL DEFAULT 0,
     seq INTEGER NOT NULL,
     enqueued_at TEXT NOT NULL
   );
   CREATE TABLE scheduler_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     paused INTEGER NOT NULL
   );
   INSERT INTO scheduler_state (id, paused) VALUES (1, 0)`,
  // Asks (ticket 06). `ask` is the whole Ask as JSON; the columns are for lookups.
  `CREATE TABLE asks (
     id TEXT PRIMARY KEY,
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('open', 'answered')),
     raised_at TEXT NOT NULL,
     ask TEXT NOT NULL
   );
   CREATE INDEX asks_state ON asks (state)`,
  // Budgets and usage records (ticket 15). `config` is the kind's settings as JSON, `models` a JSON
  // list. A usage record is one reported turn; the Item, Epic, Project, Stage and kind are copied in
  // so roll-ups survive the Item moving on, and day, week and month are the core's local periods.
  // An allowance is the extra a person granted past a cap ("Continue") for one scope and period.
  `CREATE TABLE budgets (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     config TEXT NOT NULL,
     models TEXT NOT NULL
   );
   CREATE TABLE usage_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     session_id TEXT NOT NULL,
     parent_session_id TEXT,
     subagent TEXT,
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     epic_id TEXT,
     stage TEXT NOT NULL,
     item_kind TEXT NOT NULL,
     model TEXT,
     budget_id TEXT,
     turn INTEGER NOT NULL,
     context_tokens INTEGER NOT NULL,
     input_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL,
     cache_write_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cost REAL,
     unit TEXT,
     cost_usd REAL,
     idle_ms INTEGER NOT NULL,
     day TEXT NOT NULL,
     week TEXT NOT NULL,
     month TEXT NOT NULL
   );
   CREATE INDEX usage_kiln_session ON usage_records (COALESCE(parent_session_id, session_id));
   CREATE INDEX usage_budget_month ON usage_records (budget_id, month);
   CREATE INDEX usage_project_day ON usage_records (project_id, day);
   CREATE TABLE budget_allowances (
     budget_id TEXT NOT NULL,
     limit_id TEXT NOT NULL,
     scope_key TEXT NOT NULL,
     period TEXT NOT NULL,
     extra REAL NOT NULL,
     PRIMARY KEY (budget_id, limit_id, scope_key, period)
   );
   ALTER TABLE sessions ADD COLUMN model TEXT`,
  // Quota readings for subscription Budgets (ticket 17): every reading an Agent reports, as it
  // reported it, plus the window Kiln counts it toward. `after_record` is the last usage record's id
  // when it was stored, so the turns between two readings are the records between their marks.
  // A stage model is a Stage moved to its fallback model (the Fable reserve Ask), per Project.
  `CREATE TABLE quota_readings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     budget_id TEXT,
     session_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     window TEXT NOT NULL,
     model TEXT,
     window_id TEXT,
     percent REAL,
     resets_at TEXT,
     taken_at TEXT NOT NULL,
     source TEXT NOT NULL,
     using_overage INTEGER NOT NULL,
     used_credits REAL,
     after_record INTEGER NOT NULL
   );
   CREATE INDEX quota_budget_window ON quota_readings (budget_id, window_id);
   CREATE TABLE stage_models (
     project_id TEXT NOT NULL,
     item_kind TEXT NOT NULL,
     stage TEXT NOT NULL,
     model TEXT NOT NULL,
     PRIMARY KEY (project_id, item_kind, stage)
   )`,
  // Core settings an Admin changes (ticket 16: the runaway thresholds under `runaway`; ticket 25:
  // the setup wizard's choices under `setup` and `setup.*`), as JSON.
  `CREATE TABLE core_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // Custom Workflows (ticket 09): `workflow` now holds the last valid Workflow file's Workflow, used
  // only while the file is invalid. Rows without one use the default Workflow as it ships.
  `ALTER TABLE projects ADD COLUMN workflow_from_file INTEGER NOT NULL DEFAULT 0`,
  // PR mode (ticket 24): the pull requests a Gate opened, so a merge on GitHub ships the Item.
  `CREATE TABLE pull_requests (
     item_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     url TEXT NOT NULL,
     branch TEXT NOT NULL,
     widget_id TEXT NOT NULL,
     state TEXT NOT NULL,
     opened_at TEXT NOT NULL,
     PRIMARY KEY (project_id, number)
   )`,
  // A pull request closed on GitHub without merging sends its Item back to rework (state 'closed').
  `ALTER TABLE pull_requests ADD COLUMN closed_at TEXT`,
  // Variants (local-first Ticket 04): one model + quant + settings served by the local server.
  // `record` is the Variant as JSON. A removed variant's row stays, with its results.
  `CREATE TABLE variants (
     id TEXT PRIMARY KEY,
     record TEXT NOT NULL
   )`,
];

/** Opens (creating on first start) the core's one SQLite file in the data folder. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: applied } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
