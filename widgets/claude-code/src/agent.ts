// Kiln's Agent interface over the Claude Agent SDK. Each Kiln Session is one streaming `query`
// kept open across turns: Kiln's messages go in as user messages, each `result` ends a turn, and
// interrupt, resume and stop map onto the query's own controls. Claude Code's session ids, hooks
// and settings stay in here; the core sees only Agent events.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanUseTool, HookCallback, Options, PermissionResult, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentEvent, AgentMessage, AgentModel, AgentSession, EffectivePolicy, LocalSessionModel, SessionStart } from '@kiln/widget-sdk';
import { ORG_POLICY_DEFAULT } from '@kiln/widget-sdk';
import { SCRATCH, ownFolderOf, requestFor, type ToolPlace } from '@kiln/widget-sdk/tool-classifier';
import { buildSkillsPlugin, removeSessionConfig, sessionConfigDir } from './skills.ts';
import { overageCredits, readingFromRateLimit, readingsFromUsage, type UsageReply } from './quota.ts';
import { createUsageTracker } from './usage.ts';

/** The part of the SDK the Widget uses: the real one, or a test's stand-in. */
export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
}

export interface ClaudeCodeConfig {
  /**
   * The model when a Stage names none (a Claude Code alias or full id). Unset: Kiln starts no Session
   * whose Stage names none either, so Claude Code's own default is never used silently.
   */
  model?: string;
  /** The prompt-cache lifetime Claude Code keeps; default 1 hour (what it writes on a Max login). */
  cacheLifetimeMs?: number;
  /** How often to take a quota reading while a Session runs; default 5 minutes. */
  quotaIntervalMs?: number;
  /** A hard cap on one Session's API-equivalent spend, in US dollars (Claude Code stops past it). */
  maxBudgetUsd?: number;
  /** The Claude Code executable; default the one bundled with the SDK. */
  claudePath?: string;
  /** For tests only: a module to use in place of the SDK. */
  sdkModule?: string;
  /** The models this Agent offers in setup, in place of CLAUDE_MODELS (e.g. when Anthropic ships new ones). */
  models?: AgentModel[];
}

/**
 * The Claude models Claude Code runs, by the id it reports usage under. Setup offers them when an
 * Admin decides which Budget each model draws from. Override with the `models` setting.
 */
export const CLAUDE_MODELS: AgentModel[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
];

const QUOTA_INTERVAL_MS = 5 * 60_000;
const CONTINUE = 'Kiln paused you; carry on where you left off.';

/** The user messages Claude Code reads, as an async iterable that stays open until closed. */
function inputQueue() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(text: string) {
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        if (items.length) yield items.shift()!;
        else if (closed) return;
        else {
          await new Promise<void>((w) => (wake = w));
          wake = undefined;
        }
      }
    },
  };
}

interface Run {
  session: AgentSession;
  input: ReturnType<typeof inputQueue>;
  query: Query;
  /** A turn is running (a message went in and its `result` has not come back). */
  busy: boolean;
  paused: boolean;
  stopped: boolean;
  /** The running turn was interrupted, so `resume` continues it. */
  cutShort: boolean;
  /** Messages that arrived while a turn ran or the Session was paused, sent in order. */
  waiting: string[];
  permissions: Map<string, (decision: 'allow' | 'deny') => void>;
  quotaTimer?: ReturnType<typeof setInterval>;
  overageBaseline: number | null;
  usingOverage: boolean;
  /** Set when the Session runs on a local variant, with the fresh Claude Code config folder it uses. */
  local?: { model: LocalSessionModel; configDir: string };
  /** Settles once Claude Code's message stream has ended, i.e. its process is gone. */
  done: Promise<void>;
  /** The Session's own config folder (its skills plugin), removed when it stops. */
  configDir: string;
}

/** How long stop waits for Claude Code's process to exit after closing it. */
const EXIT_WAIT_MS = 5_000;

/** What the Session is told at the start, after the Stage's prompt. */
function firstMessage(start: SessionStart): string {
  const parts = [start.prompt];
  for (const artifact of start.seed?.artifacts ?? []) parts.push(`## ${artifact.name}\n\n${artifact.content}`);
  const digests = start.seed?.digests ?? [];
  if (digests.length) parts.push(`## Digests from earlier Sessions\n\n${digests.join('\n\n---\n\n')}`);
  return parts.join('\n\n');
}

function systemAppend(start: SessionStart, cwd: string): string {
  const lines = [
    `You are working as Kiln's ${start.role} Agent${start.worktree ? ', in your own git worktree' : ''}.`,
    'Kiln gives you tools on the "kiln" MCP server: raise_ask to ask the person something (blocking Asks pause you until they answer), read_item and read_artifacts for the work, and write_digest to record what you decided, changed and left open before you finish.',
    'Some tool calls need the person\'s permission first; if one is denied, do not try to get around it.',
  ];
  // Claude Code reads no settings files here (settingSources is empty), so CLAUDE.md is passed on.
  const claudeMd = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMd)) lines.push(`\nThe repo's CLAUDE.md:\n\n${readFileSync(claudeMd, 'utf8')}`);
  return lines.join('\n');
}

/**
 * Claude Code gets the Widget's environment without Kiln's credentials for the Widget. Its shell
 * goes back to the worktree after every command, so a `cd` in one call never makes the next call's
 * relative paths mean something other than what Kiln judges them by.
 */
const claudeEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KILN_'))),
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
});

/** What a local Session's Claude Code sends as its token: the local server wants one, any one. */
export const LOCAL_AUTH_TOKEN = 'kiln-local';

/**
 * The environment of a Session on a local variant: the Widget's own, less every Anthropic key or
 * login, Claude Code setting and Kiln credential, with the local server as Claude Code's API and a
 * fresh config folder (so no saved login is found). The settings are the ones the 02 check found
 * Claude Code needs against llama-server (.scratch/local-first/issues/02-llama-swap-messages-check.md).
 */
export function localClaudeEnv(parent: NodeJS.ProcessEnv, local: LocalSessionModel, configDir: string): Record<string, string> {
  const kept = Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(ANTHROPIC_|CLAUDE|KILN_)/i.test(entry[0]));
  const model = local.serverModelId;
  return {
    ...Object.fromEntries(kept),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: local.url.replace(/\/+$/, ''),
    ANTHROPIC_AUTH_TOKEN: LOCAL_AUTH_TOKEN,
    // Any side call Claude Code makes under a model alias goes to the same local model.
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    // Claude Code's mid-conversation system turn makes llama-server's chat templates fail (500).
    CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system',
    // An unknown model is assumed to have a 200K window; the real one makes Claude Code compact in time.
    ...(local.contextSize ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(local.contextSize) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  };
}

/**
 * A local turn's usage: under the variant id (it decides the local Budget), with no dollar price
 * (Claude Code makes one up for a model it doesn't know; the local Budget counts turns).
 */
function localUsage(event: AgentEvent, local: LocalSessionModel): AgentEvent {
  if (event.kind !== 'usage') return event;
  const { costUsd: _madeUp, ...rest } = event;
  return { ...rest, model: local.variantId };
}

/**
 * A local server's reply names the model its own way (llama-server: the GGUF file), while Claude
 * Code's `result.modelUsage` uses the id it asked for. Read under that id, each call is matched to
 * its turn's totals; otherwise the turn would be counted twice, and as one call the size of the
 * whole turn, which sets off the context alarm in every turn.
 */
function asServerModel(message: Record<string, unknown>, serverModelId: string): Record<string, unknown> {
  const inner = message.message as Record<string, unknown> | undefined;
  if (message.type !== 'assistant' || !inner || inner.model === '<synthetic>') return message;
  return { ...message, message: { ...inner, model: serverModelId } };
}

export function createClaudeCodeAgent(deps: { sdk: ClaudeSdk; config: ClaudeCodeConfig; dataDir: string }): Agent {
  const { sdk, config } = deps;
  const runs = new Map<string, Run>();
  let permissionIds = 0;
  /** A new, empty Claude Code config folder for one local Session, under the Widget's data folder. */
  const freshConfigDir = (sessionId: string) => {
    const root = join(deps.dataDir, 'local-claude-config');
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, `${sessionId}-`));
  };

  const emit = (run: Run, event: AgentEvent) => run.session.emit(event).catch((err: unknown) => process.stderr.write(`emit failed: ${String(err)}\n`));

  const pollQuota = async (run: Run) => {
    if (run.local) return; // No Anthropic plan behind a local Session: nothing to read.
    let reply: UsageReply;
    try {
      reply = (await run.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })) as UsageReply;
    } catch {
      return; // No reading: the windows stay unknown in Kiln.
    }
    const credits = overageCredits(reply);
    if (credits !== null) {
      if (run.overageBaseline === null) run.overageBaseline = credits;
      else if (credits > run.overageBaseline) run.usingOverage = true;
    }
    for (const reading of readingsFromUsage(reply, new Date().toISOString(), run.usingOverage)) await emit(run, { kind: 'quota_reading', reading });
  };

  const send = (run: Run, text: string) => {
    run.busy = true;
    run.cutShort = false;
    run.input.push(text);
  };

  const deliver = (run: Run, text: string) => {
    if (run.busy || run.paused) run.waiting.push(text);
    else send(run, text);
  };

  const sendWaiting = (run: Run) => {
    if (!run.waiting.length) return false;
    send(run, run.waiting.splice(0).join('\n\n'));
    return true;
  };

  const denyPending = (run: Run) => {
    for (const answer of run.permissions.values()) answer('deny');
    run.permissions.clear();
  };

  const optionsFor = (run: Run, start: SessionStart, cwd: string): Options => {
    const policy: EffectivePolicy = start.policy ?? { actions: { ...ORG_POLICY_DEFAULT }, rules: [], knownCommands: [] };
    // The module skills go in the Session's own config folder, never the repo.
    const skills = buildSkillsPlugin(run.configDir, start.skills ?? []);
    const skillFolders = skills?.folders ?? [];
    const readRoots = start.readRoots ?? [];
    // The hook knows the shell's folder and the Session's transcript; the permission callback that
    // follows for the same tool call does not, so it looks them up by the tool call's id.
    const places = new Map<string, ToolPlace>();
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const ownFolder = ownFolderOf(input.transcript_path, input.session_id);
      const where: ToolPlace = { ...(input.cwd ? { cwd: input.cwd } : {}), ...(ownFolder ? { ownFolder } : {}) };
      places.set(input.tool_use_id, where);
      if (places.size > 200) places.delete(places.keys().next().value!);
      const request = requestFor(policy, cwd, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, skillFolders, readRoots, SCRATCH, where);
      const decision = request?.decision ?? 'allow';
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: request ? `Kiln's Policy says ${decision} for ${request.action}: ${request.detail}` : 'Allowed by Kiln',
        },
      };
    };
    const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }): Promise<PermissionResult> => {
      const request = requestFor(policy, cwd, toolName, input, skillFolders, readRoots, SCRATCH, places.get(toolUseID) ?? {});
      const decision = request?.decision ?? 'allow';
      if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
      if (decision === 'deny' || !request) return { behavior: 'deny', message: `Kiln's Policy denies ${request?.action}: ${request?.detail}` };
      if (run.stopped || signal.aborted) return { behavior: 'deny', message: 'The Session was paused or stopped.' };
      // Wait for the person: the tool must not run until Kiln answers.
      const requestId = `perm-${++permissionIds}`;
      const answered = new Promise<'allow' | 'deny'>((done) => {
        run.permissions.set(requestId, done);
        signal.addEventListener('abort', () => done('deny'), { once: true });
      });
      await emit(run, { kind: 'permission_request', requestId, action: request.action, detail: request.detail });
      const answer = await answered;
      run.permissions.delete(requestId);
      return answer === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `The person denied this (${request.action}: ${request.detail}). Do not try to get around it; carry on without it or raise an Ask.` };
    };
    const local = run.local;
    const model = local ? local.model.serverModelId : (start.model ?? config.model);
    return {
      cwd,
      ...(model ? { model } : {}),
      permissionMode: 'default',
      settingSources: [],
      // Claude Code's preset asks for a Co-Authored-By trailer on commits and PRs; Kiln never wants one.
      settings: { attribution: { commit: '', pr: '' } },
      hooks: { PreToolUse: [{ hooks: [hook], onFailure: 'block' }] },
      canUseTool,
      // The modules' servers, then Kiln's own, which no module can replace. Their tool calls pass the same hook.
      mcpServers: {
        ...(start.mcpServers ?? {}),
        ...(start.kilnTools ? { kiln: { type: 'http', url: start.kilnTools.url, headers: start.kilnTools.headers } } : {}),
      },
      ...(skills ? { plugins: [skills.plugin] } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(start, cwd) },
      env: local ? localClaudeEnv(process.env, local.model, local.configDir) : claudeEnv(),
      // A local Session's dollar figure is made up, so the dollar cap would stop it for nothing.
      ...(config.maxBudgetUsd && !local ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      ...(config.claudePath ? { pathToClaudeCodeExecutable: config.claudePath } : {}),
      stderr: (data: string) => process.stderr.write(data),
    };
  };

  const onMessage = async (run: Run, message: Record<string, unknown>, usage: ReturnType<typeof createUsageTracker>) => {
    usage.see(run.local ? asServerModel(message, run.local.model.serverModelId) : message);
    if (message.type === 'assistant') {
      const content = ((message.message as { content?: unknown[] } | undefined)?.content ?? []) as { type?: string; text?: string; name?: string; input?: unknown }[];
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) await emit(run, { kind: 'progress', tool: { name: block.name, input: block.input } });
        else if (block.type === 'text' && block.text && !message.parent_tool_use_id) await emit(run, { kind: 'progress', text: block.text });
      }
      return;
    }
    if (message.type === 'rate_limit_event') {
      if (run.local) return;
      const info = (message.rate_limit_info ?? {}) as Record<string, unknown>;
      if (info.isUsingOverage === true) run.usingOverage = true;
      const reading = readingFromRateLimit(info, new Date().toISOString());
      if (reading) await emit(run, { kind: 'quota_reading', reading });
      return;
    }
    if (message.type !== 'result') return;
    for (const event of usage.settle(message)) await emit(run, run.local ? localUsage(event, run.local.model) : event);
    run.busy = false;
    if (run.stopped) return;
    if (run.paused) return; // `finished interrupted` went out when Kiln interrupted.
    if (sendWaiting(run)) return;
    if (run.cutShort) return send(run, CONTINUE); // Resumed before the interrupted turn ended.
    const failed = message.is_error === true;
    const errors = Array.isArray(message.errors) ? message.errors.join('; ') : '';
    await emit(run, failed ? { kind: 'finished', reason: 'error', message: errors || String(message.subtype ?? 'error') } : { kind: 'finished', reason: 'completed' });
    void pollQuota(run);
  };

  const play = async (run: Run) => {
    const usage = createUsageTracker();
    try {
      for await (const message of run.query) await onMessage(run, message as unknown as Record<string, unknown>, usage);
      if (!run.stopped) await emit(run, { kind: 'finished', reason: 'error', message: 'Claude Code ended the Session' });
    } catch (err) {
      if (!run.stopped) await emit(run, { kind: 'finished', reason: 'error', message: String(err) });
    } finally {
      if (run.quotaTimer) clearInterval(run.quotaTimer);
      if (runs.get(run.session.start.sessionId) === run) runs.delete(run.session.start.sessionId);
      // Claude Code is gone, so its local config folder (transcripts, state) goes too.
      if (run.local) {
        try {
          await rm(run.local.configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (err) {
          process.stderr.write(`Could not remove ${run.local.configDir}: ${String(err)}\n`);
        }
      }
    }
  };

  /** Closes Claude Code and waits (EXIT_WAIT_MS at most) for its process to end. */
  const closeRun = async (run: Run) => {
    run.stopped = true;
    denyPending(run);
    if (run.quotaTimer) clearInterval(run.quotaTimer);
    run.input.close();
    run.query.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([run.done, new Promise<void>((done) => (timer = setTimeout(done, EXIT_WAIT_MS)))]);
    clearTimeout(timer);
  };

  return {
    startSession(session) {
      const { start } = session;
      const cwd = start.worktree ?? join(deps.dataDir, 'sessions', start.sessionId);
      mkdirSync(cwd, { recursive: true });
      // A Session started again under the same id: the Claude Code an earlier start left must not linger.
      const earlier = runs.get(start.sessionId);
      if (earlier) void closeRun(earlier);
      const input = inputQueue();
      const run = {
        session,
        input,
        busy: false,
        paused: false,
        stopped: false,
        cutShort: false,
        waiting: [],
        permissions: new Map(),
        overageBaseline: null,
        usingOverage: false,
        configDir: sessionConfigDir(deps.dataDir, start.sessionId),
        ...(start.local ? { local: { model: start.local, configDir: freshConfigDir(start.sessionId) } } : {}),
      } as Omit<Run, 'query' | 'done'> as Run;
      run.query = sdk.query({ prompt: input, options: optionsFor(run, start, cwd) });
      runs.set(start.sessionId, run);
      send(run, firstMessage(start));
      run.done = play(run);
      void pollQuota(run);
      run.quotaTimer = setInterval(() => void pollQuota(run), config.quotaIntervalMs ?? QUOTA_INTERVAL_MS);
      run.quotaTimer.unref();
    },

    sendMessage(sessionId, message: AgentMessage) {
      const run = runs.get(sessionId);
      if (!run || run.stopped) return;
      if (message.kind === 'permission_answer') {
        run.permissions.get(message.requestId)?.(message.decision);
        return;
      }
      if (message.kind === 'ask_answer') {
        deliver(
          run,
          message.changed
            ? `The person changed their answer to your Ask ${message.askId}: ${message.answer}. Revisit anything you did on the earlier answer.`
            : `The person answered your Ask ${message.askId}: ${message.answer}`,
        );
        return;
      }
      deliver(run, message.text);
    },

    async interrupt(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped || run.paused) return;
      run.paused = true;
      if (run.busy) {
        run.cutShort = true;
        denyPending(run);
        await run.query.interrupt();
      }
      await emit(run, { kind: 'finished', reason: 'interrupted' });
    },

    resume(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped || !run.paused) return;
      run.paused = false;
      if (run.busy) return; // The interrupted turn has not ended yet; its result carries on.
      if (!sendWaiting(run) && run.cutShort) send(run, CONTINUE);
    },

    async stop(sessionId) {
      const run = runs.get(sessionId);
      if (!run || run.stopped) return;
      if (run.quotaTimer) clearInterval(run.quotaTimer);
      await pollQuota(run);
      // Kiln may remove the worktree as soon as it hears "stopped", so the process goes first.
      await closeRun(run);
      void removeSessionConfig(run.configDir);
      await emit(run, { kind: 'finished', reason: 'stopped' });
    },
  };
}
