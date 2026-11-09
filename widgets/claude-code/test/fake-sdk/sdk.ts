// A stand-in for `@anthropic-ai/claude-agent-sdk`'s `query`, for tests. The Widget imports it in
// place of the real SDK when its config names it (`sdkModule`). It plays the scenario named in the
// Widget config (`fakeScenario`, see scenario.ts), producing the message shapes Claude Code
// produces, and goes through the Widget's hooks and permission callback the way Claude Code does:
// a PreToolUse hook's allow runs the tool, its deny blocks it, and ask (or no decision) calls
// `canUseTool`. Tools really run, so files change and commits land in the worktree. When its env
// names an API (`ANTHROPIC_BASE_URL`, a local Session), each turn also sends one Messages request
// there, as Claude Code would.
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { CanUseTool, HookCallbackMatcher, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FakeLogEntry, FakeScenario, FakeStep, FakeUsage } from './scenario.ts';

type Message = Record<string, unknown>;

const config = JSON.parse(process.env.KILN_WIDGET_CONFIG || '{}') as { fakeScenario: string };
const scenarioFile = config.fakeScenario;
const log = (entry: FakeLogEntry) => appendFileSync(`${scenarioFile}.log`, `${JSON.stringify(entry)}\n`);
let queries = 0;

/** A queue of messages the generator hands out, in order. */
function channel() {
  const items: Message[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(item: Message) {
      items.push(item);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *drain(): AsyncGenerator<Message> {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (done) return;
        await new Promise<void>((w) => (wake = w));
        wake = undefined;
      }
    },
  };
}

const userText = (message: SDKUserMessage): string => {
  const content = message.message.content;
  if (typeof content === 'string') return content;
  return content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('');
};

const logged = (options: Options): Record<string, unknown> => {
  const { canUseTool, hooks, abortController, stderr, ...rest } = options;
  return {
    ...rest,
    hasCanUseTool: typeof canUseTool === 'function',
    hooks: Object.fromEntries(Object.entries(hooks ?? {}).map(([event, matchers]) => [event, matchers?.length ?? 0])),
  };
};

export function query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const options = params.options ?? {};
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')) as FakeScenario;
  const sessionId = options.resume ?? scenario.sessionId ?? `fake-claude-session-${++queries}`;
  const cwd = options.cwd ?? process.cwd();
  const out = channel();
  let usageReply: unknown = scenario.usage ?? 'unavailable';
  let interrupted = false;
  let closed = false;
  let abort = new AbortController();
  let onInterrupt: (() => void) | undefined;
  let ids = 0;
  let turnIndex = 0;
  const costByModel = new Map<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>();
  let totalCost = 0;
  /** Subagent id -> the Agent tool_use id it runs under. */
  const subagents = new Map<string, string>();
  const env = (options.env ?? {}) as Record<string, string | undefined>;
  const configDir = env.CLAUDE_CONFIG_DIR;
  log({ kind: 'options', options: logged(options), ...(configDir ? { configDirFiles: existsSync(configDir) ? readdirSync(configDir) : null } : {}) });
  /** One Messages request to the API the env names, as Claude Code makes for each model call. */
  const callApi = async (text: string) => {
    const base = env.ANTHROPIC_BASE_URL;
    if (!base) return;
    const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? null;
    const url = `${base}/v1/messages`;
    const model = String(options.model);
    let status = 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: text }] }),
      });
      status = res.status;
      await res.arrayBuffer();
    } catch {
      status = -1;
    }
    log({ kind: 'api', url, model, token, status });
  };
  // claude.exe's stand-in: a process working in the Session's folder until the query is closed.
  const holder = scenario.holdsCwd ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { cwd, stdio: 'ignore', windowsHide: true }) : undefined;
  const holderGone = holder ? new Promise<void>((done) => holder.once('exit', () => (log({ kind: 'exited', cwd }), done()))) : Promise.resolve();
  const endOnceExited = () => {
    if (!holder) return out.end();
    setTimeout(() => holder.kill(), scenario.holdsCwd?.exitDelayMs ?? 0);
    void holderGone.then(() => out.end());
  };

  const parentOf = (subagent: string | undefined) => (subagent ? (subagents.get(subagent) ?? null) : null);
  const assistant = (content: unknown[], subagent?: string, extra: { model?: string; usage?: FakeUsage } = {}) =>
    out.push({
      type: 'assistant',
      message: {
        id: `msg_fake_${++ids}`,
        type: 'message',
        role: 'assistant',
        model: extra.model ?? 'claude-fake-1',
        content,
        usage: extra.usage ?? { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: parentOf(subagent),
      session_id: sessionId,
      uuid: `uuid-${ids}`,
    });

  const decideByHooks = async (name: string, input: Record<string, unknown>, toolUseId: string, agentId: string | undefined) => {
    for (const matcher of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
      if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test(name)) continue;
      for (const hook of matcher.hooks) {
        const output = (await hook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: name,
            tool_input: input,
            tool_use_id: toolUseId,
            session_id: sessionId,
            transcript_path: scenario.transcriptPath ?? '',
            cwd: scenario.hookCwd ?? cwd,
            ...(agentId ? { agent_id: agentId } : {}),
          },
          toolUseId,
          { signal: abort.signal },
        )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        const decision = output.hookSpecificOutput?.permissionDecision;
        if (decision) return { decision, reason: output.hookSpecificOutput?.permissionDecisionReason };
      }
    }
    return { decision: undefined, reason: undefined };
  };

  let mcpReady = false;
  let mcpIds = 0;
  const mcpSend = async (message: Message): Promise<unknown> => {
    const server = options.mcpServers?.kiln as { type: 'http'; url: string; headers?: Record<string, string> } | undefined;
    if (!server) throw new Error('No kiln MCP server configured');
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
    if (res.status === 202) return undefined;
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (!res.ok || body.error) throw new Error(`kiln ${String(message.method)} -> ${res.status}: ${body.error?.message ?? ''}`);
    return body.result;
  };
  const callKilnTool = async (tool: string, args: unknown) => {
    if (!mcpReady) {
      await mcpSend({ id: ++mcpIds, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } } });
      await mcpSend({ method: 'notifications/initialized' });
      mcpReady = true;
    }
    const result = await mcpSend({ id: ++mcpIds, method: 'tools/call', params: { name: tool, arguments: args } });
    log({ kind: 'mcp', tool, result });
    return JSON.stringify(result);
  };

  const execute = async (name: string, input: Record<string, unknown>): Promise<string> => {
    const path = (p: unknown) => (isAbsolute(String(p)) ? String(p) : resolve(cwd, String(p)));
    switch (name) {
      case 'Write':
        mkdirSync(dirname(path(input.file_path)), { recursive: true });
        writeFileSync(path(input.file_path), String(input.content));
        return 'written';
      case 'Edit': {
        const file = path(input.file_path);
        writeFileSync(file, readFileSync(file, 'utf8').replace(String(input.old_string), String(input.new_string)));
        return 'edited';
      }
      case 'Read':
        return readFileSync(path(input.file_path), 'utf8');
      case 'Bash':
        return execSync(String(input.command), { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fake Claude', GIT_AUTHOR_EMAIL: 'fake@kiln.invalid', GIT_COMMITTER_NAME: 'Fake Claude', GIT_COMMITTER_EMAIL: 'fake@kiln.invalid' } });
      default:
        if (name.startsWith('mcp__kiln__')) return callKilnTool(name.slice('mcp__kiln__'.length), input);
        return 'ok';
    }
  };

  const useTool = async (name: string, rawInput: Record<string, unknown>, subagent: string | undefined) => {
    // Claude Code hands tools absolute paths.
    const input = { ...rawInput };
    if (typeof input.file_path === 'string' && !isAbsolute(input.file_path)) input.file_path = resolve(cwd, input.file_path);
    const toolUseId = `toolu_fake_${++ids}`;
    const agentId = subagent ? `agent-${subagent}` : undefined;
    assistant([{ type: 'tool_use', id: toolUseId, name, input }], subagent);
    const result = (content: string, isError: boolean) =>
      out.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
        parent_tool_use_id: parentOf(subagent),
        session_id: sessionId,
      });
    const hook = await decideByHooks(name, input, toolUseId, agentId);
    let via: 'hook' | 'permission' = 'hook';
    let run = hook.decision === 'allow';
    let message = hook.reason;
    let finalInput = input;
    if (hook.decision !== 'allow' && hook.decision !== 'deny') {
      via = 'permission';
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      if (!canUseTool) run = false;
      else {
        const answer = await canUseTool(name, input, { signal: abort.signal, toolUseID: toolUseId, ...(agentId ? { agentID: agentId } : {}) } as Parameters<CanUseTool>[2]);
        run = answer?.behavior === 'allow';
        if (answer?.behavior === 'allow' && answer.updatedInput) finalInput = answer.updatedInput;
        if (answer?.behavior === 'deny') message = answer.message;
      }
    }
    if (interrupted) return;
    if (!run) {
      log({ kind: 'tool', name, input, outcome: 'denied', via, ...(message ? { message } : {}) });
      result(message ?? 'Permission denied', true);
      return;
    }
    try {
      const output = await execute(name, finalInput);
      log({ kind: 'tool', name, input, outcome: 'ran', via });
      result(output, false);
    } catch (err) {
      log({ kind: 'tool', name, input, outcome: 'ran', via, message: String(err) });
      result(String(err), true);
    }
  };

  const step = async (s: FakeStep, turn: { text: string; usage: FakeUsage }) => {
    if ('tool' in s) return useTool(s.tool, s.input, s.subagent);
    if ('text' in s) {
      turn.text = s.text;
      return assistant([{ type: 'text', text: s.text }]);
    }
    if ('assistant' in s) {
      const { model, usage, costUsd, subagent } = s.assistant;
      assistant([{ type: 'text', text: '…' }], subagent, { model, usage });
      // Claude Code keys `modelUsage` by the model it asked for. A cloud reply names that model; a
      // local server's reply names its own (llama-server: the GGUF file), so the two keys differ.
      const key = env.ANTHROPIC_BASE_URL ? String(options.model) : model;
      const m = costByModel.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
      m.inputTokens += usage.input_tokens;
      m.outputTokens += usage.output_tokens;
      m.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
      m.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
      m.costUSD += costUsd;
      costByModel.set(key, m);
      totalCost += costUsd;
      turn.usage.input_tokens += usage.input_tokens;
      turn.usage.output_tokens += usage.output_tokens;
      return;
    }
    if ('subagent' in s) {
      const toolUseId = `toolu_fake_${++ids}`;
      subagents.set(s.subagent.id, toolUseId);
      assistant([{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: s.subagent.description, prompt: '…', subagent_type: 'general-purpose' } }]);
      out.push({ type: 'system', subtype: 'task_started', task_id: `task-${s.subagent.id}`, tool_use_id: toolUseId, description: s.subagent.description, session_id: sessionId });
      return;
    }
    if ('rateLimit' in s) {
      out.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', ...s.rateLimit }, session_id: sessionId });
      return;
    }
    if ('waitForInterrupt' in s) {
      if (!interrupted) await new Promise<void>((done) => (onInterrupt = done));
      return;
    }
    if ('setUsage' in s) usageReply = s.setUsage;
  };

  const runTurn = async (steps: FakeStep[]) => {
    const turn = { text: '', usage: { input_tokens: 0, output_tokens: 0 } };
    interrupted = false;
    abort = new AbortController();
    for (const s of steps) {
      if (interrupted || closed) break;
      await step(s, turn);
    }
    if (closed) return;
    out.push({
      type: 'result',
      subtype: interrupted ? 'error_during_execution' : 'success',
      is_error: interrupted,
      num_turns: turnIndex,
      result: turn.text,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: totalCost,
      usage: turn.usage,
      modelUsage: Object.fromEntries([...costByModel].map(([model, m]) => [model, { ...m, webSearchRequests: 0, contextWindow: scenario.contextWindow ?? 200_000, maxOutputTokens: 64_000 }])),
      permission_denials: [],
      session_id: sessionId,
      uuid: `uuid-result-${turnIndex}`,
    });
  };

  const play = async () => {
    out.push({ type: 'system', subtype: 'init', session_id: sessionId, cwd, model: options.model ?? 'default', tools: [], mcp_servers: [], permissionMode: options.permissionMode ?? 'default' });
    try {
      const prompt = typeof params.prompt === 'string' ? [{ type: 'user', message: { role: 'user', content: params.prompt }, parent_tool_use_id: null } as SDKUserMessage] : params.prompt;
      for await (const message of prompt) {
        if (closed) break;
        log({ kind: 'user', text: userText(message) });
        await callApi(userText(message));
        const steps = scenario.turns[turnIndex++] ?? [{ text: '(the scenario has no more turns)' }];
        await runTurn(steps);
      }
    } catch (err) {
      out.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [String(err)], total_cost_usd: totalCost, usage: {}, modelUsage: {}, session_id: sessionId });
    }
    endOnceExited();
  };
  void play();

  const generator = out.drain();
  const controls = {
    async interrupt() {
      log({ kind: 'interrupt' });
      interrupted = true;
      abort.abort();
      onInterrupt?.();
      onInterrupt = undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      log({ kind: 'close' });
      abort.abort();
      onInterrupt?.();
      endOnceExited();
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(_request?: { skipBehaviors?: boolean }) {
      if (usageReply === 'unavailable') throw new Error('Usage is not available for this login');
      return usageReply;
    },
    async setPermissionMode() {},
  };
  return Object.assign(generator, controls) as unknown as Query;
}
