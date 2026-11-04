// The Claude Code Agent Widget process: runs Kiln Sessions with Claude Code through the Claude
// Agent SDK (see agent.ts).
//
// Config (KILN_WIDGET_CONFIG), all optional: model, models, cacheLifetimeMs, quotaIntervalMs,
// maxBudgetUsd, claudePath, and sdkModule (tests only). See ClaudeCodeConfig.
//
// Claude Code signs in the way it does on this PC (the person's own login); the Widget reads no
// Claude Code settings files and passes none on.
import { pathToFileURL } from 'node:url';
import { createWidgetClient, serveAgent } from '@kiln/widget-sdk';
import { CLAUDE_MODELS, createClaudeCodeAgent, type ClaudeCodeConfig, type ClaudeSdk } from './agent.ts';

const client = createWidgetClient();
const config = (client.context.config ?? {}) as ClaudeCodeConfig;
const sdkModule = config.sdkModule
  ? config.sdkModule.startsWith('file:')
    ? config.sdkModule
    : pathToFileURL(config.sdkModule).href
  : '@anthropic-ai/claude-agent-sdk';
const sdk = (await import(sdkModule)) as ClaudeSdk;
// Its Manifest asks for a data folder (where a Session with no worktree works), so it has one.
const dataDir = client.context.dataDir;
if (!dataDir) throw new Error('The Claude Code Widget was started without its data folder');

await serveAgent(createClaudeCodeAgent({ sdk, config, dataDir }), {
  client,
  agents: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      cacheLifetimeMs: config.cacheLifetimeMs ?? 60 * 60_000,
      ...(config.model ? { model: config.model } : {}),
      models: config.models ?? CLAUDE_MODELS,
    },
  ],
});
