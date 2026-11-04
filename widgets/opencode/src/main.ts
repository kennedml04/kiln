// The OpenCode Agent Widget process. Each Kiln Session runs in its own `opencode serve` (see
// session.ts); this file is the Kiln side: register the Agent, follow the command stream, report
// each Session's events.
//
// It talks to the core over the plain Widget API with `fetch` and imports only types from the SDK
// (erased at run time), so it runs from a clone of the public repo that has no node_modules.
// Config (KILN_WIDGET_CONFIG): see OpenCodeWidgetConfig in config.ts.
import type { AgentEvent, AgentRegistration, WidgetCommand } from '@kiln/widget-sdk';
import { DEFAULT_CACHE_LIFETIME_MS, offeredModels, parseConfig } from './config.ts';
import { readSse } from './server.ts';
import { OpenCodeSession } from './session.ts';

const env = process.env;
const api = env.KILN_API_URL;
const dataDir = env.KILN_WIDGET_DATA_DIR ?? process.cwd();
const config = parseConfig(JSON.parse(env.KILN_WIDGET_CONFIG || '{}'));
const log = (message: string) => process.stderr.write(`${message}\n`);

const auth = { authorization: `Bearer ${env.KILN_WIDGET_TOKEN}` };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
};

const AGENT: AgentRegistration = {
  id: 'opencode',
  name: 'OpenCode',
  cacheLifetimeMs: config.cacheLifetimeMs ?? DEFAULT_CACHE_LIFETIME_MS,
  ...(config.model ? { model: config.model } : {}),
  models: offeredModels(config),
};

const sessions = new Map<string, OpenCodeSession>();

async function handle(command: WidgetCommand) {
  switch (command.type) {
    case 'agent.start_session': {
      const start = command.session;
      const session = new OpenCodeSession({
        start,
        config,
        fallbackDir: dataDir,
        emit: (event: AgentEvent) => call('POST', '/api/widget/agent-events', { sessionId: start.sessionId, event }),
        log,
      });
      sessions.set(start.sessionId, session);
      return session.run();
    }
    case 'agent.send_message':
      return sessions.get(command.sessionId)?.send(command.message);
    case 'agent.interrupt':
      return sessions.get(command.sessionId)?.interrupt();
    case 'agent.resume':
      return sessions.get(command.sessionId)?.resume();
    case 'agent.stop': {
      const session = sessions.get(command.sessionId);
      sessions.delete(command.sessionId);
      return session?.stop();
    }
    case 'widget.stop':
      return shutdown();
  }
}

function shutdown(): never {
  for (const session of sessions.values()) session.server?.close();
  process.exit(0);
}

await call('POST', '/api/widget/register', { agents: [AGENT] });
const stream = await fetch(`${api}/api/widget/commands`, { headers: { ...auth, accept: 'text/event-stream' } });
if (!stream.ok || !stream.body) throw new Error(`Command stream failed: ${stream.status}`);
await call('POST', '/api/widget/ready');
await readSse(stream.body, (data) => {
  Promise.resolve(handle(JSON.parse(data) as WidgetCommand)).catch((err: unknown) => log(String(err)));
});
// No command stream means no core: don't leave OpenCode servers behind.
shutdown();
