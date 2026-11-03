import type { DatabaseSync } from 'node:sqlite';
import type { Role, User } from '@kiln/widget-sdk';

export const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];

const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3 };

/** Whether `role` is at least `needed` (Admin > Member > Viewer). No role reaches nothing. */
export function hasRole(role: Role | null, needed: Role): boolean {
  return role !== null && RANK[role] >= RANK[needed];
}

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as string[]).includes(value);

/** Users and their roles. Tailnet users are remembered the first time they connect, with no role. */
export interface UserStore {
  get(id: string): User | undefined;
  /** Records that this user connected; creates them with no role on first sight. */
  seen(id: string, name?: string): User;
  setRole(id: string, role: Role | null, name?: string): User;
  list(): User[];
}

interface Row {
  id: string;
  name: string | null;
  role: Role | null;
  first_seen: string;
  last_seen: string;
}

const toUser = (row: Row): User => {
  const user: User = { id: row.id, role: row.role, firstSeen: row.first_seen, lastSeen: row.last_seen };
  if (row.name !== null) user.name = row.name;
  return user;
};

export function createUserStore(db: DatabaseSync): UserStore {
  const select = db.prepare('SELECT * FROM users WHERE id = ?');
  const upsertSeen = db.prepare(
    `INSERT INTO users (id, name, role, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, name = COALESCE(excluded.name, users.name)`,
  );
  const upsertRole = db.prepare(
    `INSERT INTO users (id, name, role, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET role = excluded.role, name = COALESCE(excluded.name, users.name)`,
  );
  const all = db.prepare('SELECT * FROM users ORDER BY id');

  const get = (id: string) => {
    const row = select.get(id) as unknown as Row | undefined;
    return row ? toUser(row) : undefined;
  };

  return {
    get,
    seen(id, name) {
      const now = new Date().toISOString();
      upsertSeen.run(id, name ?? null, now, now);
      return get(id)!;
    },
    setRole(id, role, name) {
      const now = new Date().toISOString();
      upsertRole.run(id, name ?? null, role, now, now);
      return get(id)!;
    },
    list: () => (all.all() as unknown as Row[]).map(toUser),
  };
}
