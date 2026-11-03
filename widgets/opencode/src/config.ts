// The Widget's install config, and the OpenCode config each Session's server runs with.
import type { SessionStart } from '@kiln/widget-sdk';
import { openCodePermission } from './policy.ts';

/** A model server on this machine that speaks the OpenAI API (llama.cpp, Ollama, LM Studio, vLLM...). */
export interface LocalProvider {
  /** e.g. http://127.0.0.1:11434/v1 */
  baseURL: string;
  /** The model ids it serves. Kiln sees each as `<provider>/<model>`, which is what a local Budget lists. */
  models: string[];
  name?: string;
  apiKey?: string;
  /** The models' context window in tokens (what the server was started with). Kiln's context alarm uses it. */
  contextWindow?: number;
  /** The most tokens a reply may take. Default: a quarter of the context window, at most 32,000. */
  outputLimit?: number;
}

/** KILN_WIDGET_CONFIG. Every field is optional. */
export interface OpenCodeWidgetConfig {
  /** How to run OpenCode, default ["opencode"]; "node" first means the core's Node. */
  opencode?: string[];
  /**
   * The model, as OpenCode names it (`<provider>/<model>`), when the Stage names none. Usage is
   * reported under this name, so it is what a Budget lists.
   */
  model?: string;
  /**
   * Local model servers, by provider id. Their turns report no cost: a local Budget counts turns.
   * Point `model` at one (`<provider>/<model>`) to run Sessions on it.
   */
  local?: Record<string, LocalProvider>;
  /** Passed to OpenCode's `provider` config as is (keys, base URLs for metered providers). */
  providers?: Record<string, unknown>;
  /** The prompt-cache lifetime Kiln plans resumes with. Default 5 minutes. */
  cacheLifetimeMs?: number;
  /** Extra system instructions for every Session. */
  instructions?: string;
}

export const DEFAULT_CACHE_LIFETIME_MS = 5 * 60_000;

export function parseConfig(raw: unknown): OpenCodeWidgetConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as OpenCodeWidgetConfig;
  if (c.opencode !== undefined && (!Array.isArray(c.opencode) || !c.opencode.length)) throw new Error('"opencode" must be a command list, like ["opencode"]');
  for (const [id, p] of Object.entries(c.local ?? {})) {
    if (!p?.baseURL || !Array.isArray(p.models)) throw new Error(`local provider "${id}" needs a baseURL and a list of models`);
  }
  return c;
}

/** `<provider>/<model>` into its two parts, or null when it names no provider. */
export function splitModel(model: string | undefined): { providerID: string; modelID: string } | null {
  const at = model?.indexOf('/') ?? -1;
  if (!model || at <= 0 || at === model.length - 1) return null;
  return { providerID: model.slice(0, at), modelID: model.slice(at + 1) };
}

/** True when this provider is one of the configured local model servers. */
export const isLocal = (config: OpenCodeWidgetConfig, providerID: string | undefined) => !!providerID && !!config.local?.[providerID];

/** The model a Session runs: the Stage's when it names one OpenCode can use, else the Widget's. */
export function sessionModel(config: OpenCodeWidgetConfig, start: SessionStart): string | undefined {
  return splitModel(start.model) ? start.model : config.model;
}

/** OPENCODE_CONFIG_CONTENT for one Session's server. */
export function openCodeConfig(config: OpenCodeWidgetConfig, start: SessionStart): Record<string, unknown> {
  const provider: Record<string, unknown> = { ...(config.providers ?? {}) };
  for (const [id, local] of Object.entries(config.local ?? {})) {
    provider[id] = {
      npm: '@ai-sdk/openai-compatible',
      name: local.name ?? id,
      options: { baseURL: local.baseURL, ...(local.apiKey ? { apiKey: local.apiKey } : {}) },
      models: Object.fromEntries(
        local.models.map((m) => [
          m,
          {
            name: m,
            ...(local.contextWindow
              ? { limit: { context: local.contextWindow, output: local.outputLimit ?? Math.min(32_000, Math.floor(local.contextWindow / 4)) } }
              : {}),
          },
        ]),
      ),
    };
  }
  const model = sessionModel(config, start);
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(model ? { model } : {}),
    autoupdate: false,
    share: 'disabled',
    ...(start.policy ? { permission: openCodePermission(start.policy) } : {}),
    ...(start.kilnTools ? { mcp: { kiln: { type: 'remote', url: start.kilnTools.url, headers: start.kilnTools.headers, enabled: true } } } : {}),
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

/** The first prompt: Kiln's prompt, then the Artifacts and Digests the Session is seeded with. */
export function firstPrompt(start: SessionStart): string {
  const parts = [start.prompt];
  for (const artifact of start.seed?.artifacts ?? []) parts.push(`## ${artifact.name}\n\n${artifact.content}`);
  if (start.seed?.digests?.length) parts.push(`## Digests from earlier Sessions\n\n${start.seed.digests.join('\n\n---\n\n')}`);
  return parts.join('\n\n');
}
