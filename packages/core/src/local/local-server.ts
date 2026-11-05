// The local model server, behind one interface. llama-swap is the first implementation
// (llama-swap.ts); another server (Ollama, LM Studio's llama.cpp mode) would implement the same.
import type { LocalServerKind, VariantSettings } from '@kiln/widget-sdk';

/** One model entry in the server's config, as Kiln reads and writes it. */
export interface ServerEntry {
  modelId: string;
  /** The GGUF file the entry runs, when Kiln can tell. */
  modelPath?: string;
  settings: VariantSettings;
  /** The command the entry starts (e.g. a full path to llama-server), when Kiln can tell. */
  serverCommand?: string;
}

/** What the server answered to a request, and how long it took. */
export interface ServerReply {
  status: number;
  body: unknown;
  ms: number;
}

export interface LocalServer {
  kind: LocalServerKind;
  /** The model ids the server serves now (its `GET /v1/models`). */
  listModels(): Promise<string[]>;
  /** Every model entry in the server's config, hand-written ones included. */
  entries(): Promise<ServerEntry[]>;
  readEntry(modelId: string): Promise<ServerEntry | undefined>;
  /** Writes one entry (adding it when it's new). Nothing else in the config changes. */
  writeEntry(entry: ServerEntry & { modelPath: string }): Promise<void>;
  /** Takes one entry out of the config. Nothing else changes. */
  removeEntry(modelId: string): Promise<void>;
  /**
   * Waits for the server to serve what its config now says about `modelId` (listed, or gone), then
   * unloads that model alone, so its next request starts it with the new settings.
   */
  reload(modelId: string, present: boolean): Promise<void>;
  /** Sends one Anthropic Messages request (`POST /v1/messages`). Rejects when the server doesn't answer. */
  messages(body: unknown, timeoutMs: number): Promise<ServerReply>;
}
