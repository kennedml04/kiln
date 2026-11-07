// Kiln's Agent interface over the Pi coding agent's SDK. Each Kiln Session is one Pi AgentSession
// created in this process with createAgentSession(). Pi's ids, files and events stay in here; the
// core sees only Agent events.
//
// A Session loads only what Kiln sets up: the role prompt, the model, and the worktree's own context
// files (AGENTS.md, CLAUDE.md). Pi's agent folder is the Widget's own, so none of the person's
// user-level Pi extensions, skills, settings, prompts, `models.json` or credentials load.
// A run is finished only on Pi's `agent_settled`, never on `agent_end` (Pi may still retry or
// compact and carry on after that).
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession as PiSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { Agent, AgentEvent, AgentMessage, AgentSession, SessionStart } from '@kiln/widget-sdk';

/** One model this Agent offers. */
export interface PiModelConfig {
  /** The id Kiln uses in Stages and Budgets, and that usage is reported under. */
  id: string;
  name?: string;
  /**
   * A Pi built-in provider id (`openai`, `anthropic`, `openrouter`, ...) for a metered model; the
   * Widget's `apiKey` secret is its key. Unset: a local model on `localBaseUrl`, which has no cost.
   */
  provider?: string;
  /** The id the provider knows it by, when it differs from `id`. */
  providerModelId?: string;
  /** A local model's context window in tokens, when the server does not say. */
  contextWindow?: number;
}

export interface PiConfig {
  /** The model when a Stage names none. Unset: Kiln starts no Session whose Stage names none. */
  model?: string;
  models?: PiModelConfig[];
  /** The local OpenAI-compatible server (LM Studio, llama-swap), e.g. `http://127.0.0.1:1234/v1`. */
  localBaseUrl?: string;
  /** The prompt-cache lifetime reported for the model in use; default 5 minutes. */
  cacheLifetimeMs?: number;
  /**
   * Until the Policy hook ships, a Session gets only Pi's read-only tools. Set this to give it
   * bash, edit and write as well, with nothing asking first.
   */
  allowAllTools?: boolean;
}

const LOCAL_PROVIDER = 'kiln-local';
const CONTINUE = 'Kiln paused you; carry on where you left off.';
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'];

/** What the Session is told at the start, after the Stage's prompt. */
function firstMessage(start: SessionStart): string {
  const parts = [start.prompt];
  for (const artifact of start.seed?.artifacts ?? []) parts.push(`## ${artifact.name}\n\n${artifact.content}`);
  const digests = start.seed?.digests ?? [];
  if (digests.length) parts.push(`## Digests from earlier Sessions\n\n${digests.join('\n\n---\n\n')}`);
  return parts.join('\n\n');
}

function roleInstructions(start: SessionStart): string {
  return `You are working as Kiln's ${start.role} Agent${start.worktree ? ', in your own git worktree' : ''}.`;
}

const inside = (folder: string, file: string) => {
  const rel = relative(folder, file);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

interface Run {
  session: AgentSession;
  pi?: PiSession;
  unsubscribe?: () => void;
  turn: number;
  paused: boolean;
  stopped: boolean;
  /** The last assistant message ended in an error (its text), until the next one ends well. */
  failure?: string;
}

export function createPiAgent(deps: { config: PiConfig; dataDir: string; secret: (name: string) => Promise<string> }): Agent {
  const { config, dataDir } = deps;
  const runs = new Map<string, Run>();
  /** Pi's agent folder: the Widget's own, so the person's ~/.pi never loads. */
  const agentDir = join(dataDir, 'pi-agent');

  const emit = (run: Run, event: AgentEvent) => run.session.emit(event).catch((err: unknown) => process.stderr.write(`emit failed: ${String(err)}\n`));

  const modelFor = (id: string): PiModelConfig => {
    const found = (config.models ?? []).find((m) => m.id === id);
    if (!found) throw new Error(`The Pi Widget has no model "${id}" configured`);
    return found;
  };

  /** Pi's model runtime for this model: the local server from a `models.json` we write, or a provider's key. */
  const modelRuntime = async (offer: PiModelConfig) => {
    mkdirSync(agentDir, { recursive: true });
    const modelsPath = join(agentDir, 'models.json');
    const authPath = join(agentDir, 'auth.json');
    const providers: Record<string, unknown> = {};
    if (!offer.provider) {
      if (!config.localBaseUrl) throw new Error(`"${offer.id}" is a local model but the Pi Widget has no localBaseUrl`);
      providers[LOCAL_PROVIDER] = {
        baseUrl: config.localBaseUrl,
        api: 'openai-completions',
        apiKey: 'local',
        models: (config.models ?? [])
          .filter((m) => !m.provider)
          .map((m) => ({ id: m.id, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
      };
    }
    writeFileSync(modelsPath, JSON.stringify({ providers }));
    const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
    if (offer.provider) {
      let key: string;
      try {
        key = await deps.secret('apiKey');
      } catch {
        throw new Error('The Pi Widget needs its "apiKey" secret for this model; an Admin enters it in the Widget settings');
      }
      await runtime.setRuntimeApiKey(offer.provider, key);
    }
    return runtime;
  };

  const isLocal = (run: Run) => {
    const id = run.session.start.model ?? config.model;
    return !(config.models ?? []).find((m) => m.id === id)?.provider;
  };

  const onEvent = async (run: Run, event: AgentSessionEvent) => {
    if (event.type === 'tool_execution_start') {
      await emit(run, { kind: 'progress', tool: { name: event.toolName, input: event.args } });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message;
      const text = message.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim();
      if (text) await emit(run, { kind: 'progress', text });
      run.failure = message.stopReason === 'error' ? (message.errorMessage ?? 'Pi reported an error') : undefined;
      run.turn += 1;
      await emit(run, {
        kind: 'usage',
        turn: run.turn,
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
        ...(run.pi?.model?.contextWindow ? { contextWindow: run.pi.model.contextWindow } : {}),
        // A local model reports no cost.
        ...(!isLocal(run) && message.usage.cost ? { costUsd: message.usage.cost.total } : {}),
      });
    } else if (event.type === 'agent_settled') {
      if (run.stopped || run.paused) return; // `finished` went out when Kiln interrupted or stopped.
      await emit(run, run.failure ? { kind: 'finished', reason: 'error', message: run.failure } : { kind: 'finished', reason: 'completed' });
    }
  };

  /** Starts a prompt without waiting for the run; a failure to start it finishes the Session in error. */
  const prompt = (run: Run, text: string) => {
    const pi = run.pi;
    if (!pi) return;
    pi.prompt(text, pi.isStreaming ? { streamingBehavior: 'steer' } : undefined).catch((err: unknown) => {
      if (!run.stopped) void emit(run, { kind: 'finished', reason: 'error', message: String(err) });
    });
  };

  const close = async (run: Run) => {
    run.stopped = true;
    run.unsubscribe?.();
    const pi = run.pi;
    if (!pi) return;
    try {
      await pi.abort();
    } finally {
      pi.dispose();
    }
  };

  const create = async (run: Run) => {
    const { start } = run.session;
    const cwd = start.worktree ?? join(dataDir, 'sessions', start.sessionId);
    mkdirSync(cwd, { recursive: true });
    const modelId = start.model ?? config.model;
    if (!modelId) throw new Error('No model: the Stage names none and the Pi Widget has no default');
    const offer = modelFor(modelId);
    const runtime = await modelRuntime(offer);
    const providerId = offer.provider ?? LOCAL_PROVIDER;
    const model = runtime.getModel(providerId, offer.providerModelId ?? offer.id);
    if (!model) throw new Error(`Pi does not know the model "${offer.providerModelId ?? offer.id}" on ${providerId}`);
    // Pi's cache keep-warm refresh is off: Kiln's pause, resume and expiry handle the timing. Compaction stays on.
    const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: true } });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [roleInstructions(start)],
      // Only the worktree's own AGENTS.md / CLAUDE.md, not a parent folder's.
      agentsFilesOverride: (base) => ({ agentsFiles: base.agentsFiles.filter((f) => inside(cwd, f.path)) }),
    });
    await resourceLoader.reload();
    const sessionDir = join(dataDir, 'sessions-pi', start.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRuntime: runtime,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.create(cwd, sessionDir),
      ...(config.allowAllTools ? {} : { tools: READ_ONLY_TOOLS }),
    });
    run.pi = session;
    run.unsubscribe = session.subscribe((event) => void onEvent(run, event));
    if (run.stopped) return close(run);
    prompt(run, firstMessage(start));
  };

  return {
    startSession(session) {
      const id = session.start.sessionId;
      const earlier = runs.get(id);
      if (earlier) void close(earlier);
      const run: Run = { session, turn: 0, paused: false, stopped: false };
      runs.set(id, run);
      create(run).catch((err: unknown) => {
        if (!run.stopped) void emit(run, { kind: 'finished', reason: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    },

    sendMessage(sessionId, message: AgentMessage) {
      const run = runs.get(sessionId);
      if (!run || run.stopped || !run.pi) return;
      if (message.kind === 'permission_answer') return;
      const text =
        message.kind === 'ask_answer'
          ? message.changed
            ? `The person changed their answer to your Ask ${message.askId}: ${message.answer}. Revisit anything you did on the earlier answer.`
            : `The person answered your Ask ${message.askId}: ${message.answer}`
          : message.text;
      prompt(run, text);
    },

    async interrupt(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped || run.paused) return;
      run.paused = true;
      await run.pi?.abort();
      await emit(run, { kind: 'finished', reason: 'interrupted' });
    },

    resume(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped || !run.paused) return;
      run.paused = false;
      prompt(run, CONTINUE);
    },

    async stop(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped) return;
      // Kiln may remove the worktree as soon as it hears "stopped", so Pi goes first.
      await close(run);
      runs.delete(sessionId);
      await emit(run, { kind: 'finished', reason: 'stopped' });
    },
  };
}
