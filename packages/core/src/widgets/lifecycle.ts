// Widget lifecycle: installs, approval, start, stop, update, remove and crash restarts.
//
// An install is kept in SQLite (`widget_installs`) and its pin in `<data dir>/widgets.lock.json`.
// Nothing runs until an Admin approves the Manifest. The process itself is run by the Widget host.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CORE_API_VERSION,
  type InstallWidgetRequest,
  type Manifest,
  type WidgetGrants,
  type WidgetInfo,
  type WidgetLockfile,
  type WidgetPin,
  type UpdateWidgetRequest,
  type WidgetSourcePolicy,
  type WidgetState,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { removeFolder } from '../exec.ts';
import { WidgetHostError, type WidgetHost } from '../widget-host.ts';
import { satisfies } from './core-api-range.ts';
import { eventSubscription, grantAllows, grantsFor, newNeeds } from './grants.ts';
import { hashFolder, normalizeSource, resolveWidget, sourceAllowed, type ResolvedWidget } from './sources.ts';

export const LOCKFILE = 'widgets.lock.json';
const SOURCE_POLICY_KEY = 'widgetSources';

interface InstallRecord {
  id: string;
  manifest: Manifest;
  pin: WidgetPin;
  folder: string;
  config: unknown;
  grants: WidgetGrants | null;
  installedAt: string;
  /** Whether an Admin wants it running; the core starts it again on boot. */
  wanted?: boolean;
  /** When the current pin was locked (install or last update). */
  lockedAt?: string;
  /** A resolved update that asks for more than the grants, waiting for an Admin. */
  pendingUpdate?: (ResolvedWidget & { newNeeds: string[] }) | null;
}

export interface WidgetLifecycle {
  list(): WidgetInfo[];
  /** The Org Policy's allowed Widget sources. */
  sourcePolicy(): WidgetSourcePolicy;
  setSourcePolicy(policy: WidgetSourcePolicy): WidgetSourcePolicy;
  /** Resolves and pins the source, then waits for approval. 403 `source` when the Org Policy says no. */
  install(request: InstallWidgetRequest): WidgetInfo;
  /**
   * Grants what the Manifest asks for, then starts it. With an update pending, grants its Manifest
   * and swaps it in. `approvedBy` is the Admin's user id.
   */
  approve(id: string, approvedBy: string): Promise<WidgetInfo>;
  start(id: string): WidgetInfo;
  stop(id: string): Promise<WidgetInfo>;
  /**
   * Resolves the source again (at `ref`, or the installed ref). Asks for nothing new: swaps it in,
   * restarting the Widget if it was running. Asks for more: holds it as a pending update.
   */
  update(id: string, request: UpdateWidgetRequest): Promise<WidgetInfo>;
  /** Stops the Widget and drops its install, lock entry and checkouts. Its data folder is kept. */
  remove(id: string): Promise<void>;
  /** Whether this Widget's grants cover a call to the core API. */
  allows(id: string, method: string, url: URL): boolean;
  /** What this Widget may follow of these event types. */
  subscription(id: string, types: string[]): ReturnType<typeof eventSubscription>;
  /** The secret names this Widget was granted. */
  grantedSecrets(id: string): string[];
  /** Whether this Widget was granted raising Asks (`needs.asks`). */
  mayRaiseAsks(id: string): boolean;
  /**
   * The capacity pools approved Widgets add (`provides.pools`), with their default sizes. When two
   * Widgets declare the same pool, the smaller size holds.
   */
  grantedPools(): Record<string, number>;
  /** Starts every approved install that was running when the core last stopped. */
  resume(): void;
  /** Cancels pending restarts (the core is stopping). */
  close(): void;
}

export interface LifecycleDeps {
  db: DatabaseSync;
  bus: EventBus;
  host: WidgetHost;
  dataDir: string;
  /** The core API's address, known once the core is listening. */
  apiUrl(): string;
  /** The first wait before restarting a crashed Widget; each further crash doubles it. Default 1000. */
  restartMs?: number;
  /** Called while a Widget is removed, before it is forgotten (e.g. to delete its secrets). */
  onRemove?(widget: WidgetInfo): Promise<void>;
}

/** Restarts allowed in a row before a Widget is marked unhealthy. */
export const MAX_RESTARTS = 5;
const MAX_RESTART_DELAY_MS = 60_000;

/** What the core knows about a Widget beyond its process: restarts and why it is down. */
interface Runtime {
  restarts: number;
  /** Crashes in a row; reset once the Widget stays ready long enough. */
  failures: number;
  phase: 'restarting' | 'unhealthy' | null;
  timer: NodeJS.Timeout | null;
  problem: string | null;
}

/** Why this Manifest can't run on this core, or null when it can. */
const incompatibility = (manifest: Manifest): string | null =>
  satisfies(CORE_API_VERSION, manifest.coreApi)
    ? null
    : `Incompatible: it supports core API ${manifest.coreApi}, and this core is ${CORE_API_VERSION}`;

export function createWidgetLifecycle({ db, bus, host, dataDir, apiUrl, restartMs = 1000, onRemove }: LifecycleDeps): WidgetLifecycle {
  const codeRoot = join(dataDir, 'widgets');
  const installs = new Map<string, InstallRecord>();
  const runtimes = new Map<string, Runtime>();
  const runtime = (id: string): Runtime => {
    let r = runtimes.get(id);
    if (!r) runtimes.set(id, (r = { restarts: 0, failures: 0, phase: null, timer: null, problem: null }));
    return r;
  };
  const settle = (id: string) => {
    const r = runtime(id);
    if (r.timer) clearTimeout(r.timer);
    Object.assign(r, { failures: 0, phase: null, timer: null, problem: null });
  };
  for (const row of db.prepare('SELECT record FROM widget_installs').all() as { record: string }[]) {
    const record = JSON.parse(row.record) as InstallRecord;
    installs.set(record.id, record);
  }

  const save = (record: InstallRecord) => {
    installs.set(record.id, record);
    db.prepare('INSERT INTO widget_installs (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record').run(
      record.id,
      JSON.stringify(record),
    );
    writeLockfile();
  };

  const writeLockfile = () => {
    const lock: WidgetLockfile = { lockfileVersion: 1, widgets: {} };
    for (const r of [...installs.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      lock.widgets[r.id] = { ...r.pin, version: r.manifest.version, lockedAt: r.lockedAt ?? r.installedAt };
    }
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, LOCKFILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(lock, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };

  const info = (r: InstallRecord): WidgetInfo => {
    const proc = host.process(r.id);
    const running = proc && proc.state !== 'stopped' && proc.state !== 'exited';
    const rt = runtime(r.id);
    const state: WidgetState = running
      ? (proc.state as Exclude<typeof proc.state, 'exited'>)
      : !r.grants
        ? 'awaiting-approval'
        : incompatibility(r.manifest)
          ? 'incompatible'
          : (rt.phase ?? 'stopped');
    return {
      id: r.id,
      name: r.manifest.name,
      version: r.manifest.version,
      folder: r.folder,
      pin: r.pin,
      manifest: r.manifest,
      grants: r.grants,
      pendingUpdate: r.pendingUpdate
        ? { manifest: r.pendingUpdate.manifest, pin: r.pendingUpdate.pin, newNeeds: r.pendingUpdate.newNeeds }
        : null,
      state,
      problem: incompatibility(r.manifest) ?? rt.problem,
      restarts: rt.restarts,
      pid: running ? proc.pid : null,
      agents: running ? proc.agents : [],
    };
  };

  const sourcePolicy = (): WidgetSourcePolicy => {
    const row = db.prepare('SELECT value FROM org_policy WHERE key = ?').get(SOURCE_POLICY_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as WidgetSourcePolicy) : { allowed: null };
  };

  const get = (id: string) => {
    const record = installs.get(id);
    if (!record) throw new WidgetHostError(404, `No Widget "${id}" is installed`);
    return record;
  };

  const isRunning = (id: string) => {
    const state = host.process(id)?.state;
    return state !== undefined && state !== 'stopped' && state !== 'exited';
  };

  const start = (record: InstallRecord) => {
    if (!record.grants) throw new WidgetHostError(409, `Widget "${record.id}" is waiting for an Admin to approve it`);
    const incompatible = incompatibility(record.manifest);
    if (incompatible) throw new WidgetHostError(409, incompatible);
    if (isRunning(record.id)) return;
    spawn(record);
  };

  const spawn = (record: InstallRecord) => {
    // A folder source runs in place, so check it is still the code that was approved.
    if (record.pin.kind === 'folder' && hashFolder(record.folder) !== record.pin.hash) {
      runtime(record.id).problem = 'Its folder changed since it was installed; update it to approve the new code';
      throw new WidgetHostError(409, runtime(record.id).problem!);
    }
    host.start({ folder: record.folder, manifest: record.manifest, config: record.config, apiUrl: apiUrl() });
  };

  /** Puts resolved code in place of the installed code; a running Widget is restarted on it. */
  const swap = async (record: InstallRecord, next: ResolvedWidget) => {
    const wasRunning = isRunning(record.id);
    settle(record.id);
    if (wasRunning) await host.stop(record.id);
    Object.assign(record, { manifest: next.manifest, pin: next.pin, folder: next.folder, pendingUpdate: null, lockedAt: new Date().toISOString() });
    save(record);
    bus.publish('widget.updated', { widgetId: record.id, version: record.manifest.version, pin: record.pin });
    if ((wasRunning || record.wanted) && record.grants && !incompatibility(record.manifest)) start(record);
  };

  const want = (record: InstallRecord, wanted: boolean) => {
    if (record.wanted === wanted) return;
    record.wanted = wanted;
    save(record);
  };

  // A Widget that exits without being asked is restarted with backoff, then marked unhealthy.
  let closed = false;
  host.onExit((id, exit) => {
    const record = installs.get(id);
    if (!record || exit.asked || closed) return;
    const rt = runtime(id);
    if (exit.readyForMs !== null && exit.readyForMs >= restartMs * 60) rt.failures = 0;
    rt.failures++;
    rt.problem = `Exited with code ${exit.code ?? 'none (killed)'}`;
    if (rt.failures > MAX_RESTARTS) {
      rt.phase = 'unhealthy';
      rt.problem = `Unhealthy: it crashed ${rt.failures} times in a row; last exit code ${exit.code ?? 'none (killed)'}`;
      bus.publish('widget.unhealthy', { widgetId: id, failures: rt.failures, code: exit.code, problem: rt.problem });
      return;
    }
    const delayMs = Math.min(restartMs * 2 ** (rt.failures - 1), MAX_RESTART_DELAY_MS);
    rt.phase = 'restarting';
    bus.publish('widget.restarting', { widgetId: id, attempt: rt.failures, delayMs, code: exit.code });
    rt.timer = setTimeout(() => {
      rt.timer = null;
      const current = installs.get(id);
      if (!current || closed || isRunning(id)) return;
      rt.phase = null;
      rt.restarts++;
      try {
        spawn(current);
      } catch (err) {
        rt.phase = 'unhealthy';
        rt.problem = `Could not restart: ${err instanceof Error ? err.message : String(err)}`;
        bus.publish('widget.unhealthy', { widgetId: id, failures: rt.failures, code: null, problem: rt.problem });
      }
    }, delayMs);
  });

  return {
    allows: (id, method, url) => grantAllows(installs.get(id)?.grants ?? null, method, url),
    subscription: (id, types) => eventSubscription(installs.get(id)?.grants ?? null, types),
    grantedSecrets: (id) => [...(installs.get(id)?.grants?.needs.secrets ?? [])],
    mayRaiseAsks: (id) => installs.get(id)?.grants?.needs.asks === true,
    grantedPools() {
      const pools: Record<string, number> = {};
      for (const record of installs.values()) {
        for (const [name, size] of Object.entries(record.grants?.pools ?? {})) pools[name] = Math.min(pools[name] ?? size, size);
      }
      return pools;
    },

    resume() {
      for (const record of installs.values()) {
        if (!record.wanted || !record.grants || incompatibility(record.manifest)) continue;
        try {
          start(record);
        } catch (err) {
          runtime(record.id).problem = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    },

    close() {
      closed = true;
      for (const rt of runtimes.values()) if (rt.timer) clearTimeout(rt.timer);
    },

    list: () => [...installs.values()].map(info),

    async approve(id, approvedBy) {
      const record = get(id);
      const pending = record.pendingUpdate;
      record.grants = grantsFor(pending?.manifest ?? record.manifest, approvedBy);
      save(record);
      bus.publish('widget.approved', { widgetId: id, grants: record.grants });
      if (pending) await swap(record, pending);
      else if (!incompatibility(record.manifest)) {
        settle(id);
        start(record);
        want(record, true);
      }
      return info(record);
    },

    start(id) {
      const record = get(id);
      settle(id);
      start(record);
      want(record, true);
      return info(record);
    },

    async stop(id) {
      const record = get(id);
      settle(id);
      want(record, false);
      await host.stop(id);
      return info(record);
    },

    async update(id, request) {
      const record = get(id);
      if (!sourceAllowed(sourcePolicy(), record.pin.source)) {
        throw new WidgetHostError(403, `The Org Policy no longer allows ${record.pin.source}`, 'source');
      }
      const ref = request?.ref ?? record.pin.ref;
      const next = resolveWidget({ source: record.pin.source, ...(ref ? { ref } : {}), ...(record.pin.path ? { path: record.pin.path } : {}) }, codeRoot);
      if (next.manifest.id !== id) throw new WidgetHostError(400, `The source now holds Widget "${next.manifest.id}", not "${id}"`);
      const same = next.pin.commit === record.pin.commit && next.pin.hash === record.pin.hash;
      if (same) {
        if (record.pendingUpdate) {
          record.pendingUpdate = null;
          save(record);
        }
        return info(record);
      }
      const asks = record.grants ? newNeeds(record.grants, next.manifest) : [];
      if (asks.length) {
        record.pendingUpdate = { ...next, newNeeds: asks };
        save(record);
        bus.publish('widget.update_pending', { widgetId: id, version: next.manifest.version, newNeeds: asks });
        return info(record);
      }
      await swap(record, next);
      return info(record);
    },

    async remove(id) {
      const record = get(id);
      settle(id);
      await host.stop(id);
      await onRemove?.(info(record));
      installs.delete(id);
      runtimes.delete(id);
      db.prepare('DELETE FROM widget_installs WHERE id = ?').run(id);
      writeLockfile();
      // Only Kiln's own checkouts; a folder source is the Admin's folder and is never deleted.
      await removeFolder(join(codeRoot, id, 'code'));
      bus.publish('widget.removed', { widgetId: id });
    },

    sourcePolicy,

    setSourcePolicy(policy) {
      const allowed = policy?.allowed;
      if (allowed !== null && (!Array.isArray(allowed) || allowed.some((s) => typeof s !== 'string' || !s))) {
        throw new WidgetHostError(400, 'allowed must be null (any source) or a list of sources');
      }
      const value: WidgetSourcePolicy = { allowed };
      db.prepare('INSERT INTO org_policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
        SOURCE_POLICY_KEY,
        JSON.stringify(value),
      );
      bus.publish('org_policy.widget_sources_changed', value);
      return value;
    },

    install(request) {
      if (!request || typeof request.source !== 'string' || !request.source) throw new WidgetHostError(400, 'source is required');
      if (!sourceAllowed(sourcePolicy(), request.source)) {
        throw new WidgetHostError(403, `The Org Policy does not allow installing from ${normalizeSource(request.source)}`, 'source');
      }
      const resolved = resolveWidget(request, codeRoot);
      const id = resolved.manifest.id;
      if (installs.has(id)) throw new WidgetHostError(409, `Widget "${id}" is already installed; update it instead`);
      const record: InstallRecord = {
        id,
        manifest: resolved.manifest,
        pin: resolved.pin,
        folder: resolved.folder,
        config: request.config ?? {},
        grants: null,
        installedAt: new Date().toISOString(),
      };
      save(record);
      const widget = info(record);
      bus.publish('widget.installed', { widget });
      return widget;
    },
  };
}

