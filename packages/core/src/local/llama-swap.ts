// llama-swap as Kiln's local server: its YAML config is read and spliced (llama-swap-config.ts),
// and its HTTP API answers the rest. llama-swap picks up an edited config when it runs with
// `--watch-config`; Kiln waits for `GET /v1/models` to show the change and never restarts llama-swap.
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { LocalServerSettings } from '@kiln/widget-sdk';
import { buildCommand, ConfigError, parseCommand, readEntries, removeEntry, setEntryCmd } from './llama-swap-config.ts';
import type { LocalServer, ServerEntry } from './local-server.ts';

const POLL_MS = 250;

export function createLlamaSwap(settings: LocalServerSettings & { configPath: string; url: string }): LocalServer {
  const base = settings.url.replace(/\/+$/, '');
  const { configPath } = settings;

  const readConfig = async () => {
    try {
      return await readFile(configPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Kiln can't read the llama-swap config at ${configPath}: ${(err as Error).message}`);
    }
  };
  /** Written next to the config and renamed over it, so llama-swap never reads half a file. */
  const writeConfig = async (text: string) => {
    const temp = `${configPath}.kiln-${process.pid}.tmp`;
    await writeFile(temp, text, 'utf8');
    await rename(temp, configPath);
  };

  const entries = async (): Promise<ServerEntry[]> =>
    readEntries(await readConfig()).map(({ modelId, cmd }) => {
      if (cmd === undefined) return { modelId, settings: { extraFlags: [] } };
      const parsed = parseCommand(cmd);
      return { modelId, settings: parsed.settings, ...(parsed.modelPath ? { modelPath: parsed.modelPath } : {}), ...(parsed.serverCommand ? { serverCommand: parsed.serverCommand } : {}) };
    });

  const listModels = async () => {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`GET /v1/models answered ${res.status}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  };

  return {
    kind: 'llama-swap',
    listModels,
    entries,
    readEntry: async (modelId) => (await entries()).find((e) => e.modelId === modelId),
    async writeEntry(entry) {
      const cmd = buildCommand(entry.serverCommand ?? settings.serverCommand, entry.modelPath, entry.settings);
      await writeConfig(setEntryCmd(await readConfig(), entry.modelId, cmd));
    },
    async removeEntry(modelId) {
      const text = await readConfig();
      const next = removeEntry(text, modelId);
      if (next !== text) await writeConfig(next);
    },
    async reload(modelId, present) {
      const deadline = Date.now() + settings.reloadTimeoutSeconds * 1000;
      let last = '';
      for (;;) {
        try {
          if ((await listModels()).includes(modelId) === present) break;
          last = present ? `it doesn't list "${modelId}" yet` : `it still lists "${modelId}"`;
        } catch (err) {
          last = (err as Error).message;
        }
        if (Date.now() > deadline) {
          throw new Error(`llama-swap didn't pick up the edited config within ${settings.reloadTimeoutSeconds}s (${last}). Is it running with --watch-config?`);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      // Only this model is unloaded: a running entry of its own picks up the new settings, and
      // nothing else the server runs is touched.
      if (present) {
        await fetch(`${base}/api/models/unload/${encodeURIComponent(modelId)}`, { method: 'POST', signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      }
    },
    async messages(body, timeoutMs) {
      const started = Date.now();
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON: kept as text, for the failure reason.
      }
      return { status: res.status, body: parsed, ms: Date.now() - started };
    },
  };
}
