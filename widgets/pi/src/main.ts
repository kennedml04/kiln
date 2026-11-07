// The Pi Agent Widget process: runs Kiln Sessions with the Pi coding agent through its SDK
// (see agent.ts). Pi is not the default Agent; a Stage chooses it.
//
// Config (KILN_WIDGET_CONFIG): model, models, localBaseUrl, cacheLifetimeMs, allowAllTools. See PiConfig.
// Secret `apiKey`: the key for metered models; local models need none.
import { createWidgetClient, serveAgent } from '@kiln/widget-sdk';
import { createPiAgent, type PiConfig } from './agent.ts';

const client = createWidgetClient();
const config = (client.context.config ?? {}) as PiConfig;
const dataDir = client.context.dataDir;
if (!dataDir) throw new Error('The Pi Widget was started without its data folder');

await serveAgent(createPiAgent({ config, dataDir, secret: (name) => client.secret(name) }), {
  client,
  agents: [
    {
      id: 'pi',
      name: 'Pi',
      cacheLifetimeMs: config.cacheLifetimeMs ?? 5 * 60_000,
      ...(config.model ? { model: config.model } : {}),
      models: (config.models ?? []).map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.provider === undefined ? { local: true } : {}) })),
    },
  ],
});
