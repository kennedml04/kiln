// Local-first routing (Ticket 07): the results, pins and install-wide switch behind the picker, and
// Ticket size. The choosing itself is the pure function in picker.ts.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { defaultRoleMode, type LocalRouting, type RoleMode, type Stage, type TicketSize, type VariantResult } from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';
import { hashSeed, pickVariant, seededRandom, type Pick as Picked } from './picker.ts';

/**
 * Ticket size, from the Item's earlier attempts, else its estimate, else medium. The thresholds:
 * small is at most 40 lines changed in at most 3 files; large is over 250 lines or over 8 files;
 * anything between is medium. With several earlier attempts the biggest one counts.
 */
export const SIZE_THRESHOLDS = { smallLines: 40, smallFiles: 3, largeLines: 250, largeFiles: 8 } as const;

export function sizeOfDiff(diffLines: number, files: number): TicketSize {
  const t = SIZE_THRESHOLDS;
  if (diffLines > t.largeLines || files > t.largeFiles) return 'large';
  if (diffLines <= t.smallLines && files <= t.smallFiles) return 'small';
  return 'medium';
}

const ORDER: TicketSize[] = ['small', 'medium', 'large'];

export function ticketSize(history: readonly { diffLines?: number; files?: number }[], estimate?: string): TicketSize {
  const known = history.filter((h) => h.diffLines !== undefined || h.files !== undefined);
  if (known.length) {
    const sizes = known.map((h) => sizeOfDiff(h.diffLines ?? 0, h.files ?? 0));
    return sizes.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a));
  }
  const word = estimate?.trim().toLowerCase();
  return ORDER.find((s) => s === word) ?? 'medium';
}

/** The mode a Stage's role runs in. */
export const modeOf = (stage: Pick<Stage, 'role' | 'mode'>): RoleMode => stage.mode ?? defaultRoleMode(stage.role ?? '');

export interface Routing {
  localOnlyInstall(): boolean;
  routing(): LocalRouting;
  update(input: unknown): LocalRouting;
  results(variantId?: string): VariantResult[];
  record(result: Omit<VariantResult, 'id' | 'at'>): VariantResult;
  pick(args: { role: string; size: TicketSize; itemId: string; variants: { id: string; name: string }[] }): Picked | undefined;
}

const KEY = 'localOnly';

interface Row {
  id: string;
  variant_id: string;
  role: string;
  size: string;
  passed: number;
  reason: string | null;
  wall_ms: number;
  tokens_per_second: number | null;
  item_id: string | null;
  session_id: string | null;
  diff_lines: number | null;
  files: number | null;
  at: string;
}

export function createRouting({ db, now = () => new Date() }: { db: DatabaseSync; now?: () => Date }): Routing {
  const getSetting = db.prepare('SELECT value FROM core_settings WHERE key = ?');
  const setSetting = db.prepare('INSERT INTO core_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const setPin = db.prepare('INSERT INTO variant_pins (scope, variant_id) VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET variant_id = excluded.variant_id');
  const clearPin = db.prepare('DELETE FROM variant_pins WHERE scope = ?');
  const localOnlyInstall = () => (getSetting.get(KEY) as { value: string } | undefined)?.value === 'true';
  const pins = (): Record<string, string> =>
    Object.fromEntries((db.prepare('SELECT scope, variant_id FROM variant_pins').all() as { scope: string; variant_id: string }[]).map((r) => [r.scope, r.variant_id]));
  const insert = db.prepare(
    `INSERT INTO variant_results (id, variant_id, role, size, passed, reason, wall_ms, tokens_per_second, item_id, session_id, diff_lines, files, at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM variant_results))`,
  );
  const fromRow = (r: Row): VariantResult => ({
    id: r.id,
    variantId: r.variant_id,
    role: r.role,
    size: r.size as TicketSize,
    passed: r.passed === 1,
    ...(r.reason ? { reason: r.reason } : {}),
    wallMs: r.wall_ms,
    ...(r.tokens_per_second !== null ? { tokensPerSecond: r.tokens_per_second } : {}),
    ...(r.item_id ? { itemId: r.item_id } : {}),
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    ...(r.diff_lines !== null ? { diffLines: r.diff_lines } : {}),
    ...(r.files !== null ? { files: r.files } : {}),
    at: r.at,
  });
  const results = (variantId?: string) =>
    (variantId
      ? (db.prepare('SELECT * FROM variant_results WHERE variant_id = ? ORDER BY seq').all(variantId) as unknown as Row[])
      : (db.prepare('SELECT * FROM variant_results ORDER BY seq').all() as unknown as Row[])
    ).map(fromRow);
  const state = (): LocalRouting => ({ localOnly: localOnlyInstall(), pins: pins() });
  return {
    localOnlyInstall,
    routing: state,
    update(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new WorkError(400, 'Send the routing change as an object');
      const body = input as { localOnly?: unknown; pin?: { role?: unknown; itemId?: unknown; variantId?: unknown } };
      if (body.localOnly !== undefined) {
        if (typeof body.localOnly !== 'boolean') throw new WorkError(400, '"localOnly" must be true or false');
        setSetting.run(KEY, String(body.localOnly));
      }
      if (body.pin !== undefined) {
        const { role, itemId, variantId } = body.pin ?? {};
        if ((typeof role === 'string') === (typeof itemId === 'string')) throw new WorkError(400, 'A pin names a "role" or an "itemId", not both');
        const scope = typeof role === 'string' ? `role:${role}` : `item:${itemId as string}`;
        if (variantId === null) clearPin.run(scope);
        else if (typeof variantId === 'string' && variantId) setPin.run(scope, variantId);
        else throw new WorkError(400, '"pin.variantId" must be a variant id, or null to remove the pin');
      }
      return state();
    },
    results,
    record(result) {
      const full: VariantResult = { ...result, id: `r-${randomUUID()}`, at: now().toISOString() };
      insert.run(full.id, full.variantId, full.role, full.size, full.passed ? 1 : 0, full.reason ?? null, Math.round(full.wallMs), full.tokensPerSecond ?? null, full.itemId ?? null, full.sessionId ?? null, full.diffLines ?? null, full.files ?? null, full.at);
      return full;
    },
    pick({ role, size, itemId, variants }) {
      const all = results();
      const p = pins();
      const rolePin = p[`role:${role}`];
      const ticketPin = p[`item:${itemId}`];
      return pickVariant({
        role,
        size,
        variants,
        results: all,
        ...(ticketPin ? { ticketPin } : {}),
        ...(rolePin ? { rolePin } : {}),
        random: seededRandom(hashSeed(`${itemId}:${all.length}`)),
      });
    },
  };
}
