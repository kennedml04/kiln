// The typed Widget API client, and `serveAgent`, which runs an Agent behind it.
import type { Agent, AgentEvent, AgentRegistration, AgentSession } from './agent.ts';
import type { Ask, WidgetRaiseAskRequest } from './asks.ts';
import { readSse } from './sse.ts';
import type { KilnEvent } from './index.ts';
import type { PanelContent } from './panel.ts';
import { WIDGET_ENV, type RegisterRequest, type SecretValue, type WidgetCommand } from './widget-api.ts';

export interface WidgetContext {
  apiUrl: string;
  widgetId: string;
  token: string;
  /** Its own data folder: set only when its Manifest's `needs.dataFolder` asks for one. */
  dataDir?: string;
  config: unknown;
}

/** Reads what the core passed to this Widget process. */
export function widgetContext(env: NodeJS.ProcessEnv = process.env): WidgetContext {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set: this process must be started by the Kiln core`);
    return value;
  };
  const dataDir = env[WIDGET_ENV.dataDir];
  return {
    apiUrl: need(WIDGET_ENV.apiUrl),
    widgetId: need(WIDGET_ENV.widgetId),
    token: need(WIDGET_ENV.token),
    ...(dataDir ? { dataDir } : {}),
    config: JSON.parse(env[WIDGET_ENV.config] || '{}') as unknown,
  };
}

export interface WidgetClient {
  readonly context: WidgetContext;
  /** Calls the core API with this Widget's credential. Throws on a non-2xx status. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Opens the command stream; resolves once it is connected. `onEnd` runs if the core drops it. */
  onCommand(handler: (command: WidgetCommand) => void, onEnd?: () => void): Promise<void>;
  register(request: RegisterRequest): Promise<void>;
  ready(): Promise<void>;
  /** Replaces one of its declarative panels' content (the panel must be in the Manifest). */
  publishPanel(panelId: string, content: PanelContent): Promise<void>;
  /** Sends a message to one of its embedded pages, through the Shell. */
  sendPageMessage(panelId: string, message: unknown): Promise<void>;
  /**
   * Follows core events of these types (`item.updated`, `session.*`, `widget.ready`...), as far as
   * its grants allow: rejects with the 403 when a type isn't granted. Pass the last event id seen
   * to get what was missed. Resolves once connected; `close()` on the result stops it.
   */
  subscribe(types: string[], handler: (event: KilnEvent) => void, options?: { lastEventId?: number }): Promise<{ close(): void }>;
  /** A secret the Manifest named and an Admin entered. Throws when not granted or not set. */
  secret(name: string): Promise<string>;
  /** Raises an Ask on an Item. Its answer arrives as an `ask.answered` command. */
  raiseAsk(request: WidgetRaiseAskRequest): Promise<Ask>;
  close(): void;
}

export function createWidgetClient(context: WidgetContext = widgetContext()): WidgetClient {
  const controller = new AbortController();
  const headers = (json: boolean): Record<string, string> => ({
    authorization: `Bearer ${context.token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  });
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${context.apiUrl}${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    context,
    call,
    async onCommand(handler, onEnd) {
      const res = await fetch(`${context.apiUrl}/api/widget/commands`, {
        headers: { ...headers(false), accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Command stream failed: ${res.status}`);
      void readSse(res.body, (data) => handler(JSON.parse(data) as WidgetCommand)).then(() => {
        if (!controller.signal.aborted) onEnd?.();
      });
    },
    register: (request) => call('POST', '/api/widget/register', request),
    ready: () => call('POST', '/api/widget/ready'),
    publishPanel: (panelId, content) => call('PUT', `/api/widget/panels/${encodeURIComponent(panelId)}`, content),
    sendPageMessage: (panelId, message) => call('POST', `/api/widget/panels/${encodeURIComponent(panelId)}/messages`, message),
    async subscribe(types, handler, options = {}) {
      const stop = new AbortController();
      controller.signal.addEventListener('abort', () => stop.abort());
      const res = await fetch(`${context.apiUrl}/api/widget/events?types=${encodeURIComponent(types.join(','))}`, {
        headers: {
          ...headers(false),
          accept: 'text/event-stream',
          ...(options.lastEventId !== undefined ? { 'last-event-id': String(options.lastEventId) } : {}),
        },
        signal: stop.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Event subscription failed: ${res.status}: ${await res.text()}`);
      void readSse(res.body, (data) => handler(JSON.parse(data) as KilnEvent)).catch(() => {});
      return { close: () => stop.abort() };
    },
    async secret(name) {
      return (await call<SecretValue>('GET', `/api/widget/secrets/${encodeURIComponent(name)}`)).value;
    },
    raiseAsk: (request) => call<Ask>('POST', '/api/widget/asks', request),
    close: () => controller.abort(),
  };
}

/**
 * Runs an Agent Widget: connects to the core, registers the Agents,
 * routes each command to the Agent and reports its events. Exits on `widget.stop`.
 */
export async function serveAgent(
  agent: Agent,
  options: {
    agents: AgentRegistration[];
    client?: WidgetClient;
    onStop?: () => void | Promise<void>;
    /** A person answered (or changed the answer to) an Ask this Widget raised. */
    onAskAnswered?: (ask: Ask) => void | Promise<void>;
  },
): Promise<WidgetClient> {
  const client = options.client ?? createWidgetClient();
  const sessionFor = (start: AgentSession['start']): AgentSession => ({
    start,
    emit: (event: AgentEvent) => client.call('POST', '/api/widget/agent-events', { sessionId: start.sessionId, event }),
  });
  const handle = async (command: WidgetCommand) => {
    switch (command.type) {
      case 'agent.start_session':
        return agent.startSession(sessionFor(command.session));
      case 'agent.send_message':
        return agent.sendMessage(command.sessionId, command.message);
      case 'agent.interrupt':
        return agent.interrupt(command.sessionId);
      case 'agent.resume':
        return agent.resume(command.sessionId);
      case 'agent.stop':
        return agent.stop(command.sessionId);
      case 'ask.answered':
        return options.onAskAnswered?.(command.ask);
      case 'widget.stop':
        await options.onStop?.();
        client.close();
        process.exit(0);
    }
  };
  await client.onCommand(
    (command) => {
      Promise.resolve(handle(command)).catch((err: unknown) => process.stderr.write(`${String(err)}\n`));
    },
    // The core went away: don't linger as an orphan.
    () => process.exit(0),
  );
  await client.register({ agents: options.agents });
  await client.ready();
  return client;
}
