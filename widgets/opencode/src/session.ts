// One Kiln Session, run as one OpenCode session in its own `opencode serve` (cwd = the worktree,
// the Session's own Policy and Kiln tools credential in its config).
//
// OpenCode -> Kiln: each model step (a step-finish part) is a usage turn; a child session (the task
// tool) is a subagent; a permission request becomes a `permission_request`, and OpenCode waits on it
// until Kiln answers; the main session going idle finishes the Session.
// Kiln -> OpenCode: messages are prompts, interrupt and stop abort the turn, resume prompts again.
import type { AgentEvent, AgentMessage, SessionStart } from '@kiln/widget-sdk';
import { firstPrompt, isLocal, openCodeConfig, sessionModel, splitModel, type OpenCodeWidgetConfig } from './config.ts';
import { kilnRequest, type OpenCodePermission } from './policy.ts';
import { startServer, type OpenCodeEvent, type OpenCodeServer } from './server.ts';

export interface SessionOptions {
  start: SessionStart;
  config: OpenCodeWidgetConfig;
  /** Where to run when the Session has no worktree. */
  fallbackDir: string;
  emit(event: AgentEvent): Promise<void>;
  log(message: string): void;
}

interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export class OpenCodeSession {
  // Plain fields, no parameter properties (erasable TypeScript only).
  readonly options: SessionOptions;
  server: OpenCodeServer | null = null;
  mainId = '';
  /** Busy from sending a prompt until the main session goes idle. */
  busy = false;
  paused = false;
  stopped = false;
  /** The turn is being aborted for an interrupt: its idle finishes the Session as interrupted. */
  interrupting = false;
  /** A turn error OpenCode reported (other than our own abort). */
  turnError: string | null = null;
  /** Ask answers that arrived while paused, sent with the resume. */
  heldAnswers: string[] = [];
  /** Kiln request id -> where to answer it in OpenCode. */
  permissions = new Map<string, { sessionID: string }>();
  /** Child session id -> its description. */
  children = new Map<string, string>();
  /** Assistant message id -> the model that ran it. */
  messageModels = new Map<string, { providerID?: string; modelID?: string }>();
  /** Assistant messages already reported through their step-finish parts. */
  steppedMessages = new Set<string>();
  reportedMessages = new Set<string>();
  seenParts = new Set<string>();
  turns = new Map<string, number>();
  /** "provider/model" -> context window in tokens. */
  contextWindows = new Map<string, number>();
  queue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionOptions) {
    this.options = options;
  }

  get sessionId() {
    return this.options.start.sessionId;
  }

  /** Reports events in order. */
  emit(event: AgentEvent) {
    this.queue = this.queue.then(() => this.options.emit(event)).catch((err: unknown) => this.options.log(`emit failed: ${String(err)}`));
    return this.queue;
  }

  async run() {
    const { start, config } = this.options;
    try {
      this.server = await startServer({
        command: config.opencode ?? ['opencode'],
        cwd: start.worktree ?? this.options.fallbackDir,
        config: openCodeConfig(config, start),
      });
      if (this.stopped) return this.server.close();
      void this.server.follow((e) => this.onEvent(e)).then(() => {
        if (!this.stopped) this.fail('OpenCode stopped streaming events');
      });
      await this.loadContextWindows();
      const session = await this.server.request<{ id: string }>('POST', '/session', { title: `Kiln ${start.role}: ${start.sessionId}` });
      this.mainId = session.id;
      await this.prompt(firstPrompt(start));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Reads each model's context window from OpenCode's model catalogue (models.dev plus the config). */
  async loadContextWindows() {
    try {
      const catalogue = await this.server!.request<{ providers?: { id: string; models?: Record<string, { limit?: { context?: number } }> }[] }>(
        'GET',
        '/config/providers',
      );
      for (const provider of catalogue?.providers ?? []) {
        for (const [modelID, model] of Object.entries(provider.models ?? {})) {
          const context = model.limit?.context;
          if (typeof context === 'number' && context > 0) this.contextWindows.set(`${provider.id}/${modelID}`, context);
        }
      }
    } catch (err) {
      // Not knowing the window only means Kiln's context alarm falls back to its token setting.
      this.options.log(`OpenCode model catalogue unavailable: ${String(err)}`);
    }
  }

  fail(message: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.server?.close();
    void this.emit({ kind: 'finished', reason: 'error', message });
  }

  async prompt(text: string) {
    if (!this.server || this.stopped) return;
    const model = splitModel(sessionModel(this.options.config, this.options.start));
    this.busy = true;
    this.turnError = null;
    await this.server.request('POST', `/session/${this.mainId}/prompt_async`, {
      ...(model ? { model } : {}),
      ...(this.options.config.instructions ? { system: this.options.config.instructions } : {}),
      parts: [{ type: 'text', text }],
    });
  }

  async abort() {
    if (this.server && this.mainId) await this.server.request('POST', `/session/${this.mainId}/abort`).catch(() => {});
  }

  // --- Kiln -> OpenCode -------------------------------------------------------------------

  async send(message: AgentMessage) {
    if (message.kind === 'text') return this.prompt(message.text);
    if (message.kind === 'permission_answer') {
      const where = this.permissions.get(message.requestId);
      if (!where || !this.server) return;
      this.permissions.delete(message.requestId);
      await this.server.request('POST', `/session/${where.sessionID}/permissions/${message.requestId}`, {
        response: message.decision === 'allow' ? 'once' : 'reject',
      });
      return;
    }
    const text = message.changed
      ? `The answer to your earlier question changed. It is now: ${message.answer}`
      : `The answer to your question: ${message.answer}`;
    if (this.paused) this.heldAnswers.push(text);
    else await this.prompt(text);
  }

  async interrupt() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    if (!this.busy) return void this.emit({ kind: 'finished', reason: 'interrupted' });
    this.interrupting = true;
    await this.abort();
  }

  async resume() {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    const held = this.heldAnswers.splice(0);
    await this.prompt(held.length ? held.join('\n\n') : 'Kiln paused you and you have now been resumed. Carry on with the work where you left off.');
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.busy) await this.abort();
    this.server?.close();
    await this.emit({ kind: 'finished', reason: 'stopped' });
  }

  // --- OpenCode -> Kiln -------------------------------------------------------------------

  /** True for the main session and the subagents under it. */
  ours(sessionID: unknown): sessionID is string {
    return typeof sessionID === 'string' && (sessionID === this.mainId || this.children.has(sessionID));
  }

  onEvent(event: OpenCodeEvent) {
    if (this.stopped) return;
    const p = event.properties ?? {};
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        const info = p.info ?? {};
        if (info.parentID && this.ours(info.parentID) && !this.children.has(info.id)) {
          this.children.set(info.id, String(info.title ?? 'subagent').replace(/\s*\(@[^)]*subagent\)\s*$/, ''));
        }
        return;
      }
      case 'message.updated':
        return this.onMessage(p.info ?? {});
      case 'message.part.updated':
        return this.onPart(p.part ?? {});
      case 'permission.asked':
      case 'permission.updated':
        return this.onPermission(p as OpenCodePermission);
      case 'session.error': {
        if (p.sessionID !== undefined && p.sessionID !== this.mainId) return;
        const name = p.error?.name;
        if (name === 'MessageAbortedError') return;
        this.turnError = String(p.error?.data?.message ?? name ?? 'OpenCode reported an error');
        return;
      }
      case 'session.idle':
        if (p.sessionID === this.mainId) this.onIdle();
        return;
      case 'session.status':
        if (p.sessionID === this.mainId && p.status?.type === 'idle') this.onIdle();
        return;
    }
  }

  onIdle() {
    if (!this.busy) return;
    this.busy = false;
    if (this.interrupting) {
      this.interrupting = false;
      return void this.emit({ kind: 'finished', reason: 'interrupted' });
    }
    if (this.turnError) return void this.emit({ kind: 'finished', reason: 'error', message: this.turnError });
    void this.emit({ kind: 'finished', reason: 'completed' });
  }

  onMessage(info: Record<string, any>) {
    if (info.role !== 'assistant' || !this.ours(info.sessionID)) return;
    this.messageModels.set(info.id, { providerID: info.providerID, modelID: info.modelID });
    // A message whose steps were not reported one by one is reported once, when it completes.
    if (info.time?.completed && !this.steppedMessages.has(info.id) && !this.reportedMessages.has(info.id)) {
      const tokens = (info.tokens ?? {}) as Tokens;
      if ((tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) > 0) {
        this.reportedMessages.add(info.id);
        this.usage(info.sessionID, info.id, tokens, info.cost);
      }
    }
  }

  onPart(part: Record<string, any>) {
    if (!this.ours(part.sessionID)) return;
    switch (part.type) {
      case 'step-finish':
        if (this.seenParts.has(part.id)) return;
        this.seenParts.add(part.id);
        this.steppedMessages.add(part.messageID);
        return this.usage(part.sessionID, part.messageID, part.tokens ?? {}, part.cost);
      case 'text':
        if (part.synthetic || this.seenParts.has(part.id) || (part.time && !part.time.end)) return;
        this.seenParts.add(part.id);
        if (part.text && part.sessionID === this.mainId) void this.emit({ kind: 'progress', text: String(part.text) });
        return;
      case 'tool': {
        const state = part.state ?? {};
        if (part.tool === 'task' && typeof state.metadata?.sessionId === 'string') {
          this.children.set(state.metadata.sessionId, String(state.input?.description ?? this.children.get(state.metadata.sessionId) ?? 'subagent'));
        }
        const key = `${part.id}:tool`;
        if (state.status === 'pending' || this.seenParts.has(key)) return;
        this.seenParts.add(key);
        void this.emit({ kind: 'progress', tool: { name: String(part.tool), input: state.input } });
        return;
      }
    }
  }

  usage(sessionID: string, messageID: string, tokens: Tokens, cost: unknown) {
    const model = this.messageModels.get(messageID);
    const fallback = splitModel(sessionModel(this.options.config, this.options.start));
    const providerID = model?.providerID ?? fallback?.providerID;
    const modelID = model?.modelID ?? fallback?.modelID;
    const turn = (this.turns.get(sessionID) ?? 0) + 1;
    this.turns.set(sessionID, turn);
    const sub = sessionID === this.mainId ? undefined : { id: sessionID, description: this.children.get(sessionID) ?? 'subagent' };
    const name = providerID && modelID ? `${providerID}/${modelID}` : undefined;
    const contextWindow = name ? this.contextWindows.get(name) : undefined;
    void this.emit({
      kind: 'usage',
      turn,
      ...(name ? { model: name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      inputTokens: tokens.input ?? 0,
      outputTokens: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
      cacheReadTokens: tokens.cache?.read ?? 0,
      cacheWriteTokens: tokens.cache?.write ?? 0,
      // A local model costs no money: report none, rather than OpenCode's zero.
      ...(typeof cost === 'number' && !isLocal(this.options.config, providerID) ? { costUsd: cost } : {}),
      ...(sub ? { subagent: sub } : {}),
    });
  }

  onPermission(request: OpenCodePermission) {
    if (!request.id || !this.ours(request.sessionID) || this.permissions.has(request.id)) return;
    this.permissions.set(request.id, { sessionID: request.sessionID });
    const { action, detail } = kilnRequest(request, this.options.start.policy, this.options.start.worktree);
    void this.emit({ kind: 'permission_request', requestId: request.id, action, detail });
  }
}
