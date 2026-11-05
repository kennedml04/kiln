// Variants and the local model server (local-first Ticket 04). A variant is one model + quant +
// settings combination served by the local server (llama-swap first). Kiln keeps a record of each,
// writes its entry in the server's config and smoke-tests it.
import type { KilnEvent } from './index.ts';

/** The local server implementations Kiln can drive. */
export type LocalServerKind = 'llama-swap';

/**
 * `GET` and `PUT /api/local-server` (Admin): where the local server is. A PUT may name only the
 * fields it changes. Nothing is assumed: until `configPath` and `url` are set, variants can't be
 * written or tested.
 */
export interface LocalServerSettings {
  kind: LocalServerKind;
  /** The server's YAML config file (llama-swap's `config.yaml`). */
  configPath?: string;
  /** The server's base URL, e.g. `http://127.0.0.1:8080` (it serves `/v1/models` and `/v1/messages`). */
  url?: string;
  /** The command an entry Kiln writes starts the model with. Default `llama-server`. */
  serverCommand: string;
  /** How long a smoke test waits for the model to load and answer. Default 300. */
  smokeTimeoutSeconds: number;
  /** How long Kiln waits for the server to pick up an edited config. Default 30. */
  reloadTimeoutSeconds: number;
}

export const LOCAL_SERVER_DEFAULTS: LocalServerSettings = {
  kind: 'llama-swap',
  serverCommand: 'llama-server',
  smokeTimeoutSeconds: 300,
  reloadTimeoutSeconds: 30,
};

/** The GGUF file a variant runs. Size and quant are unknown for a hand-written entry whose file Kiln can't read. */
export interface GgufFile {
  path: string;
  sizeBytes?: number;
  /** e.g. `Q4_K_M`, read from the file name when not given. */
  quant?: string;
}

/**
 * How the server runs the model. Kiln writes these as llama-server flags; a hand-written entry's
 * are read back from its command line, and an unset one is left to llama-server's default.
 */
export interface VariantSettings {
  /** Context size in tokens (`-c`). */
  contextSize?: number;
  /** Layers on the GPU (`-ngl`); 999 means all of them. */
  gpuLayers?: number;
  /** KV cache type for keys and values (`--cache-type-k` / `--cache-type-v`), e.g. `f16`, `q8_0`. */
  kvCacheType?: string;
  /** CPU threads (`-t`). */
  threads?: number;
  /** Any other llama-server flags, one argument per entry, e.g. `["--jinja", "-fa", "on"]`. */
  extraFlags: string[];
}

/**
 * A variant's state. `disabled` always carries why (a failed smoke test, a person, or "found in the
 * server's config, not enabled yet"). `removed`: its entry is gone from the server's config, but the
 * record and its results stay.
 */
export type VariantState = 'enabled' | 'disabled' | 'removed';

/** One smoke test: load the model, then one short Anthropic Messages request that asks for a tool call. */
export interface SmokeTestResult {
  at: string;
  passed: boolean;
  /** How long the model took to load and answer a one-token request. */
  loadMs?: number;
  /** Output tokens per second on the tool-call request. */
  tokensPerSecond?: number;
  /** Why it failed, in plain words. */
  reason?: string;
}

export interface Variant {
  id: string;
  name: string;
  /** The model id the server serves it under (its llama-swap entry's key, and the `model` of a request). */
  serverModelId: string;
  file?: GgufFile;
  settings: VariantSettings;
  state: VariantState;
  /** Set while `disabled`. */
  disabledReason?: string;
  /** `kiln`: added through Kiln. `server`: found in the server's config, written by hand. */
  origin: 'kiln' | 'server';
  /** False for a variant found in the server that has no Kiln record yet (enable it to keep one). */
  recorded: boolean;
  /** The command its entry starts, when it isn't the Setting's (a hand-written entry's own path). */
  serverCommand?: string;
  lastSmokeTest?: SmokeTestResult;
  addedAt?: string;
  removedAt?: string;
}

/** GET /api/variants: every recorded variant (removed ones included) and the server's entries not yet recorded. */
export interface VariantList {
  variants: Variant[];
  /** Whether the server's config and URL answered; `error` says what didn't. */
  server: { configured: boolean; reachable: boolean; error?: string };
}

/** POST /api/variants (Admin): writes the entry, reloads the server and smoke-tests it. */
export interface AddVariantRequest {
  name: string;
  /** Default: made from the file name. */
  serverModelId?: string;
  file: { path: string; quant?: string };
  settings: VariantSettings & { contextSize: number; gpuLayers: number; kvCacheType: string };
}

/**
 * PATCH /api/variants/:id (Admin). A change to the file or settings rewrites its entry, reloads the
 * server and smoke-tests it again; a new name alone doesn't.
 */
export interface EditVariantRequest {
  name?: string;
  file?: { path: string; quant?: string };
  settings?: Partial<VariantSettings>;
}

/** POST /api/variants/:id/disable (Admin). */
export interface DisableVariantRequest {
  reason?: string;
}

/** A variant was added, changed, smoke-tested, enabled, disabled or removed. */
export type VariantUpdatedEvent = KilnEvent<'variant.updated', { variant: Variant }>;
