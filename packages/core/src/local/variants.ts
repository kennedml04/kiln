// Variants (local-first Ticket 04): the core's record of each model + quant + settings the local
// server runs. Adding or changing one writes its own entry in the server's config, waits for the
// server to pick it up and smoke-tests it; a failed smoke test leaves it disabled with the reason.
// Entries a person wrote by hand show up as variants that can be enabled. A removed variant's entry
// leaves the config, but its record (and its results) stays.
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  LOCAL_SERVER_DEFAULTS,
  type AddVariantRequest,
  type EditVariantRequest,
  type GgufFile,
  type LocalSessionModel,
  type LocalServerSettings,
  type SmokeTestResult,
  type Variant,
  type VariantList,
  type VariantSettings,
} from '@kiln/widget-sdk';
import type { Clock } from '../clock.ts';
import type { EventBus } from '../events.ts';
import { WorkError } from '../work/work.ts';
import { ConfigError, quantOf } from './llama-swap-config.ts';
import { createLlamaSwap } from './llama-swap.ts';
import type { LocalServer, ServerEntry } from './local-server.ts';
import { runSmokeTest } from './smoke-test.ts';
import { modelBytes } from './split-gguf.ts';

const SETTINGS_KEY = 'local-server';
/** Settings with no default; a PUT of null clears one. */
const OPTIONAL_SETTINGS = new Set(['configPath', 'url', 'modelsFolder']);
/** llama.cpp's KV cache types. */
export const KV_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];
/** Flags Kiln writes itself, so they can't also be extra flags. */
const OWN_FLAGS = new Set(['--port', '-m', '--model', '-c', '--ctx-size', '-ngl', '--n-gpu-layers', '--gpu-layers', '-ctk', '--cache-type-k', '-ctv', '--cache-type-v', '-t', '--threads']);
export const FOUND_REASON = "Found in the local server's config; enable it to use it";

export interface VariantService {
  settings(): LocalServerSettings;
  /** The recorded, enabled variants, in the order they were added (no call to the server). */
  enabled(): Variant[];
  setSettings(input: unknown): LocalServerSettings;
  list(): Promise<VariantList>;
  get(id: string): Promise<Variant>;
  add(input: unknown): Promise<Variant>;
  edit(id: string, input: unknown): Promise<Variant>;
  enable(id: string): Promise<Variant>;
  disable(id: string, reason?: string): Promise<Variant>;
  remove(id: string): Promise<Variant>;
  smokeTest(id: string): Promise<Variant>;
  /**
   * The local variant a Session on `model` runs on, or undefined when `model` is no variant's id
   * (a cloud model). 409 for a disabled or removed variant, or while the server has no URL.
   */
  localModel(model: string): LocalSessionModel | undefined;
}

export interface VariantServiceDeps {
  db: DatabaseSync;
  bus: EventBus;
  clock: Clock;
  /** The server for the given settings. Default: llama-swap. */
  server?: (settings: LocalServerSettings & { configPath: string; url: string }) => LocalServer;
}

type StoredVariant = Omit<Variant, 'recorded'>;

const bad = (message: string) => new WorkError(400, message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const wholeAtLeast = (value: unknown, name: string, min: number) => {
  if (!Number.isInteger(value) || (value as number) < min) throw bad(`"${name}" must be a whole number of ${min} or more`);
  return value as number;
};

/** A model id or variant id made from free text: lower case, letters, digits, dots, dashes. */
export const slug = (text: string) =>
  text.toLowerCase().replace(/\.gguf$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'variant';

/** Checks settings from a request. `partial`: an edit, where only what is given changes. */
function readSettings(input: unknown, partial: boolean): Partial<VariantSettings> {
  if (!isObject(input)) throw bad('"settings" must be an object');
  const out: Partial<VariantSettings> = {};
  const need = (key: string) => {
    if (!partial && input[key] === undefined) throw bad(`"settings.${key}" is required`);
    return input[key] !== undefined;
  };
  if (need('contextSize')) out.contextSize = wholeAtLeast(input.contextSize, 'settings.contextSize', 256);
  if (need('gpuLayers')) out.gpuLayers = wholeAtLeast(input.gpuLayers, 'settings.gpuLayers', 0);
  if (need('kvCacheType')) {
    if (typeof input.kvCacheType !== 'string' || !KV_CACHE_TYPES.includes(input.kvCacheType)) {
      throw bad(`"settings.kvCacheType" must be one of ${KV_CACHE_TYPES.join(', ')}`);
    }
    out.kvCacheType = input.kvCacheType;
  }
  if (input.threads !== undefined) out.threads = wholeAtLeast(input.threads, 'settings.threads', 1);
  if (input.extraFlags !== undefined || !partial) {
    const flags = input.extraFlags ?? [];
    if (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string')) throw bad('"settings.extraFlags" must be a list of strings');
    const own = (flags as string[]).find((f) => OWN_FLAGS.has(f.split('=')[0]!));
    if (own) throw bad(`"${own}" is set by Kiln from the variant's file and settings; it can't be an extra flag`);
    out.extraFlags = flags as string[];
  }
  return out;
}

/** The GGUF file's size and quant, after checking it is a GGUF file. */
async function readGguf(input: unknown): Promise<GgufFile> {
  if (!isObject(input) || typeof input.path !== 'string' || !input.path) throw bad('"file.path" must name a GGUF file');
  const path = input.path;
  if (!isAbsolute(path)) throw bad(`"file.path" must be a full path: ${path}`);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    throw bad(`There is no file at ${path}`);
  }
  const handle = await open(path, 'r');
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    if (bytesRead < 4 || buffer.toString('latin1') !== 'GGUF') throw bad(`${path} is not a GGUF file`);
  } finally {
    await handle.close();
  }
  if (input.quant !== undefined && typeof input.quant !== 'string') throw bad('"file.quant" must be text');
  const quant = (input.quant as string | undefined) || quantOf(path);
  // Part 1 of a split GGUF counts every part.
  return { path, sizeBytes: (await modelBytes(path)) ?? size, ...(quant ? { quant } : {}) };
}

/** What Kiln can tell about a hand-written entry's file without failing on it. */
async function describeFile(path: string | undefined): Promise<GgufFile | undefined> {
  if (!path) return undefined;
  const quant = quantOf(path);
  const size = await modelBytes(path);
  return { path, ...(size !== undefined ? { sizeBytes: size } : {}), ...(quant ? { quant } : {}) };
}

export function createVariantService({ db, bus, clock, server: makeServer = createLlamaSwap }: VariantServiceDeps): VariantService {
  const now = () => clock.now().toISOString();

  // ---- the local server Setting ----
  const readSettingsRow = db.prepare('SELECT value FROM core_settings WHERE key = ?');
  const upsertSetting = db.prepare('INSERT INTO core_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const settings = (): LocalServerSettings => {
    const row = readSettingsRow.get(SETTINGS_KEY) as { value: string } | undefined;
    return { ...LOCAL_SERVER_DEFAULTS, ...(row ? (JSON.parse(row.value) as Partial<LocalServerSettings>) : {}) };
  };
  const setSettings = (input: unknown): LocalServerSettings => {
    if (!isObject(input)) throw bad('Send the local server settings to change as an object');
    const next: Record<string, unknown> = { ...settings() };
    for (const [key, value] of Object.entries(input)) {
      if (!(key in LOCAL_SERVER_DEFAULTS) && !OPTIONAL_SETTINGS.has(key)) throw bad(`"${key}" is not a local server setting`);
      if (key === 'kind' && value !== 'llama-swap') throw bad('"kind" must be llama-swap (the only local server Kiln drives so far)');
      if (OPTIONAL_SETTINGS.has(key) && value === null) {
        delete next[key];
        continue;
      }
      if (key === 'configPath' && (typeof value !== 'string' || !isAbsolute(value))) throw bad('"configPath" must be the full path of the llama-swap config file');
      if (key === 'modelsFolder' && (typeof value !== 'string' || !isAbsolute(value))) throw bad('"modelsFolder" must be the full path of a folder');
      if (key === 'url') {
        let parsed: URL | undefined;
        try {
          parsed = new URL(String(value));
        } catch {
          parsed = undefined;
        }
        if (typeof value !== 'string' || !parsed || !/^https?:$/.test(parsed.protocol)) throw bad('"url" must be the server\'s http:// address');
      }
      if (key === 'serverCommand' && (typeof value !== 'string' || !value.trim())) throw bad('"serverCommand" must name the command entries start');
      if ((key === 'smokeTimeoutSeconds' || key === 'reloadTimeoutSeconds') && !(typeof value === 'number' && value > 0)) {
        throw bad(`"${key}" must be a number of seconds above zero`);
      }
      next[key] = value;
    }
    const { kind: _k, ...stored } = next as unknown as LocalServerSettings;
    upsertSetting.run(SETTINGS_KEY, JSON.stringify({ kind: 'llama-swap', ...stored }));
    return settings();
  };

  /** The configured server, or a 409 that says what to set. */
  const server = (): LocalServer => {
    const s = settings();
    if (!s.configPath || !s.url) throw new WorkError(409, "Set the local server's config path and URL first (PUT /api/local-server)");
    return makeServer({ ...s, configPath: s.configPath, url: s.url });
  };

  // ---- records ----
  const selectAll = db.prepare('SELECT record FROM variants ORDER BY rowid');
  const upsertRecord = db.prepare('INSERT INTO variants (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record');
  const records = () => (selectAll.all() as { record: string }[]).map((r) => JSON.parse(r.record) as StoredVariant);
  const shown = (v: StoredVariant): Variant => ({ ...v, recorded: true });
  const save = (v: StoredVariant): Variant => {
    if (v.state !== 'disabled') delete v.disabledReason;
    upsertRecord.run(v.id, JSON.stringify(v));
    const variant = shown(v);
    bus.publish('variant.updated', { variant });
    return variant;
  };
  /** A new id from `base`, unused by any record (removed ones included) or by `alsoTaken`. */
  const freshId = (base: string, alsoTaken: Set<string> = new Set()) => {
    const taken = new Set([...records().map((r) => r.id), ...alsoTaken]);
    const root = slug(base);
    let id = root;
    for (let n = 2; taken.has(id); n++) id = `${root}-${n}`;
    return id;
  };

  /** The server's entries no live record owns, as unrecorded variants (with stable ids). */
  const found = async (entries: ServerEntry[], listed: string[]): Promise<Variant[]> => {
    const owned = new Set(records().filter((r) => r.state !== 'removed').map((r) => r.serverModelId));
    const known = new Set(entries.map((e) => e.modelId));
    const all = [...entries, ...listed.filter((id) => !known.has(id)).map((modelId): ServerEntry => ({ modelId, settings: { extraFlags: [] } }))];
    const ids = new Set<string>();
    const out: Variant[] = [];
    for (const entry of all) {
      if (owned.has(entry.modelId)) continue;
      const id = freshId(entry.modelId, ids);
      ids.add(id);
      const file = await describeFile(entry.modelPath);
      out.push({
        id,
        name: entry.modelId,
        serverModelId: entry.modelId,
        ...(file ? { file } : {}),
        settings: entry.settings,
        ...(entry.serverCommand ? { serverCommand: entry.serverCommand } : {}),
        state: 'disabled',
        disabledReason: FOUND_REASON,
        origin: 'server',
        recorded: false,
      });
    }
    return out;
  };

  const list = async (): Promise<VariantList> => {
    const recorded = records().map(shown);
    const s = settings();
    if (!s.configPath || !s.url) return { variants: recorded, server: { configured: false, reachable: false } };
    const srv = server();
    const errors: string[] = [];
    const entries = await srv.entries().catch((err: Error) => (errors.push(err.message), [] as ServerEntry[]));
    let reachable = true;
    const listed = await srv.listModels().catch((err: Error) => {
      reachable = false;
      errors.push(`The local server at ${s.url} didn't answer: ${err.message}`);
      return [] as string[];
    });
    return {
      variants: [...recorded, ...(await found(entries, listed))],
      server: { configured: true, reachable, ...(errors.length ? { error: errors.join('; ') } : {}) },
    };
  };

  /** The variant with this id: a record, or an entry found in the server. */
  const find = async (id: string): Promise<Variant> => {
    const record = records().find((r) => r.id === id);
    if (record) return shown(record);
    const listedVariant = (await list()).variants.find((v) => v.id === id);
    if (!listedVariant) throw new WorkError(404, `No variant has the id ${id}`);
    return listedVariant;
  };
  /** The record for this id, kept from a found entry when there was none. */
  const recordOf = async (id: string): Promise<StoredVariant> => {
    const { recorded: _r, ...variant } = await find(id);
    return { ...variant, addedAt: variant.addedAt ?? now() };
  };
  const notRemoved = (v: StoredVariant) => {
    if (v.state === 'removed') throw new WorkError(409, `The variant "${v.name}" was removed; add it again to use it`);
  };

  /** Writes the entry, waits for the server, smoke-tests, and saves the outcome on the record. */
  const deploy = async (v: StoredVariant): Promise<Variant> => {
    const srv = server();
    if (!v.file) throw bad(`The variant "${v.name}" has no GGUF file; name one in "file.path"`);
    try {
      await srv.writeEntry({ modelId: v.serverModelId, modelPath: v.file.path, settings: v.settings, ...(v.serverCommand ? { serverCommand: v.serverCommand } : {}) });
    } catch (err) {
      if (err instanceof ConfigError) throw new WorkError(409, err.message);
      throw err;
    }
    save({ ...v, state: 'disabled', disabledReason: 'Smoke test running' });
    let result: SmokeTestResult;
    try {
      await srv.reload(v.serverModelId, true);
      result = await runSmokeTest(srv, v.serverModelId, settings().smokeTimeoutSeconds * 1000, clock.now);
    } catch (err) {
      result = { at: now(), passed: false, reason: (err as Error).message };
    }
    return save(withResult(v, result));
  };
  const withResult = (v: StoredVariant, result: SmokeTestResult): StoredVariant =>
    result.passed
      ? { ...v, state: 'enabled', lastSmokeTest: result }
      : { ...v, state: 'disabled', disabledReason: `Smoke test failed: ${result.reason}`, lastSmokeTest: result };

  // One change at a time: each reads and writes the server's config whole.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    settings,
    setSettings,
    enabled: () => records().filter((r) => r.state === 'enabled').map(shown),
    list,
    get: find,
    add: (input) =>
      serial(async () => {
        if (!isObject(input)) throw bad('Send the variant as an object');
        const body = input as Partial<AddVariantRequest>;
        if (typeof body.name !== 'string' || !body.name.trim()) throw bad('"name" is required');
        const srv = server();
        const file = await readGguf(body.file);
        const settingsIn = readSettings(body.settings, false) as VariantSettings;
        if (body.serverModelId !== undefined && (typeof body.serverModelId !== 'string' || !/^[^\s]+$/.test(body.serverModelId))) {
          throw bad('"serverModelId" must be one word (no spaces)');
        }
        const serverModelId = body.serverModelId ?? slug(basename(file.path));
        const entries = await srv.entries().catch((err: Error) => {
          throw new WorkError(409, err.message);
        });
        if (entries.some((e) => e.modelId === serverModelId)) throw new WorkError(409, `The local server already has an entry "${serverModelId}"`);
        const variant: StoredVariant = {
          id: freshId(serverModelId),
          name: body.name.trim(),
          serverModelId,
          file,
          settings: settingsIn,
          state: 'disabled',
          disabledReason: 'Smoke test running',
          origin: 'kiln',
          addedAt: now(),
        };
        return deploy(variant);
      }),
    edit: (id, input) =>
      serial(async () => {
        if (!isObject(input)) throw bad('Send the changes as an object');
        const body = input as EditVariantRequest;
        const v = await recordOf(id);
        notRemoved(v);
        if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw bad('"name" can\'t be empty');
        const next: StoredVariant = { ...v, ...(body.name ? { name: body.name.trim() } : {}) };
        if (body.file === undefined && body.settings === undefined) return save(next);
        if (body.file !== undefined) next.file = await readGguf(body.file);
        if (body.settings !== undefined) next.settings = { ...v.settings, ...readSettings(body.settings, true) };
        return deploy(next);
      }),
    enable: (id) =>
      serial(async () => {
        const v = await recordOf(id);
        notRemoved(v);
        return save({ ...v, state: 'enabled' });
      }),
    disable: (id, reason) =>
      serial(async () => {
        const v = await recordOf(id);
        notRemoved(v);
        return save({ ...v, state: 'disabled', disabledReason: reason?.trim() || 'Disabled by a person' });
      }),
    remove: (id) =>
      serial(async () => {
        const v = await recordOf(id);
        if (v.state === 'removed') return shown(v);
        const srv = server();
        try {
          await srv.removeEntry(v.serverModelId);
        } catch (err) {
          if (err instanceof ConfigError) throw new WorkError(409, err.message);
          throw err;
        }
        // The entry is gone from the file either way; the server catches up on its own.
        await srv.reload(v.serverModelId, false).catch(() => undefined);
        return save({ ...v, state: 'removed', removedAt: now() });
      }),
    smokeTest: (id) =>
      serial(async () => {
        const v = await recordOf(id);
        notRemoved(v);
        const result = await runSmokeTest(server(), v.serverModelId, settings().smokeTimeoutSeconds * 1000, clock.now);
        return save(withResult(v, result));
      }),
    localModel(model) {
      const v = records().find((r) => r.id === model);
      if (!v) return undefined;
      if (v.state === 'removed') throw new WorkError(409, `The local variant "${v.name}" was removed; add it again to run Sessions on it`);
      if (v.state === 'disabled') throw new WorkError(409, `The local variant "${v.name}" is disabled: ${v.disabledReason ?? 'no reason given'}`);
      const { url } = settings();
      if (!url) throw new WorkError(409, `Set the local server's URL before running Sessions on "${v.name}" (PUT /api/local-server)`);
      return { variantId: v.id, serverModelId: v.serverModelId, url, ...(v.settings.contextSize ? { contextSize: v.settings.contextSize } : {}) };
    },
  };
}
