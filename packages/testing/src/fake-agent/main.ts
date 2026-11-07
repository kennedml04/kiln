// The scripted fake Agent Widget. The core starts it like any other Widget;
// each Session runs the script the test supplied (see script.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createWidgetClient, serveAgent, type Agent, type AgentMessage, type AgentSession } from '@kiln/widget-sdk';
import type { FakeAgentConfig, FakeAgentScript, FakeAgentScripts, FakeAgentSettings, FakeAgentStep } from './script.ts';

interface Run {
  session: AgentSession;
  paused: boolean;
  stopped: boolean;
  texts: string[];
  answers: Map<string, 'allow' | 'deny'>;
  /** Answers to Asks this Session raised, by Ask id (latest answer). */
  askAnswers: Map<string, string>;
  /** Blocking Asks the script is waiting on. */
  awaiting: Set<string>;
  /** Whether the MCP handshake with the Kiln tools is done. */
  mcpReady: boolean;
  /** Wakes every step waiting in `until` (a `widget_ask` with `wait: false` may wait beside the script). */
  wake: () => void;
  waiters: Set<() => void>;
}

const client = createWidgetClient();
const config = client.context.config as FakeAgentConfig;
const settingsFile = join(dirname(config.scriptFile), 'agent.json');
const settings = (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}) as FakeAgentSettings;
const runs = new Map<string, Run>();
/** Answers to Asks the Widget itself raised. */
const widgetAnswers = new Map<string, string>();
let mcpIds = 0;

/** Sends one JSON-RPC message to the Session's Kiln tools (MCP over Streamable HTTP). */
async function mcpSend(run: Run, message: Record<string, unknown>): Promise<unknown> {
  const tools = run.session.start.kilnTools;
  if (!tools) throw new Error('The Session has no Kiln tools endpoint');
  const res = await fetch(tools.url, {
    method: 'POST',
    headers: { ...tools.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
  if (res.status === 202) return undefined;
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`Kiln tools ${String(message.method)} -> ${res.status}: ${body.error?.message ?? ''}`);
  return body.result;
}

/** Calls an MCP method, doing the initialize handshake first, as an MCP client does. */
async function mcp(run: Run, method: string, params?: unknown): Promise<unknown> {
  if (!run.mcpReady) {
    await mcpSend(run, {
      id: ++mcpIds,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '0.1.0' } },
    });
    await mcpSend(run, { method: 'notifications/initialized' });
    run.mcpReady = true;
  }
  return mcpSend(run, { id: ++mcpIds, method, ...(params === undefined ? {} : { params }) });
}

async function callTool(run: Run, name: string, args: unknown) {
  const result = (await mcp(run, 'tools/call', { name, arguments: args })) as {
    content: { type: string; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join('\n'), structured: result.structuredContent, isError: result.isError === true };
}

/**
 * The script for a Session: the one script, or the longest-matching `<role>@<text>` whose text is
 * in the prompt, else the role's own, else `*`, else finish at once.
 */
const readScript = (role: string, prompt: string): FakeAgentScript => {
  const scripts = JSON.parse(readFileSync(config.scriptFile, 'utf8')) as FakeAgentScripts;
  if (Array.isArray(scripts)) return scripts;
  const [byItem] = Object.keys(scripts)
    .filter((key) => key.startsWith(`${role}@`) && prompt.includes(key.slice(role.length + 1)))
    .sort((a, b) => b.length - a.length);
  return scripts[byItem ?? role] ?? scripts['*'] ?? [];
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits until `ready()` holds; returns false if the Session was stopped first. */
async function until(run: Run, ready: () => boolean): Promise<boolean> {
  while (!run.stopped && !ready()) await new Promise<void>((wake) => run.waiters.add(wake));
  return !run.stopped;
}

function worktree(run: Run): string {
  const path = run.session.start.worktree;
  if (!path) throw new Error('This step needs a worktree, and the Session has none');
  return path;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Fake Agent', '-c', 'user.email=fake-agent@kiln.invalid', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Replaces `{session}` with the Session id, `{seed}` with the seed's artifact names and
 * `{artifact:<name>}` with that artifact's content (`(none)` when the seed has no such artifact).
 */
const fill = (run: Run, text: string) => {
  const artifacts = run.session.start.seed?.artifacts ?? [];
  return text
    .replaceAll('{session}', run.session.start.sessionId)
    .replaceAll('{seed}', artifacts.map((a) => a.name).join(', '))
    .replace(/\{artifact:([^}]+)\}/g, (_, name: string) => artifacts.find((a) => a.name === name)?.content ?? '(none)');
};

/** Pauses here if interrupted; returns false once the Session is stopped. */
async function checkpoint(run: Run): Promise<boolean> {
  if (run.stopped) return false;
  if (!run.paused) return true;
  await run.session.emit({ kind: 'finished', reason: 'interrupted' });
  return until(run, () => !run.paused);
}

async function perform(run: Run, step: FakeAgentStep, turn: { n: number }): Promise<boolean> {
  const { session } = run;
  switch (step.do) {
    case 'write': {
      const path = fill(run, step.path);
      const file = resolve(worktree(run), path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, fill(run, step.content));
      await session.emit({ kind: 'progress', tool: { name: 'write', input: { path } } });
      return true;
    }
    case 'commit': {
      const message = fill(run, step.message);
      const repo = step.in ? resolve(worktree(run), step.in) : worktree(run);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', ...(step.amend ? ['--amend'] : []), '-m', message);
      await session.emit({ kind: 'progress', tool: { name: 'commit', input: { message } } });
      return true;
    }
    case 'progress':
      await session.emit({ kind: 'progress', text: fill(run, step.text) });
      return true;
    case 'report_policy':
      await session.emit({ kind: 'progress', text: `policy: ${JSON.stringify(run.session.start.policy ?? null)}` });
      return true;
    case 'usage': {
      const { do: _, times = 1, intervalMs, ...usage } = step;
      for (let i = 0; i < times; i++) {
        if (i > 0 && !(await checkpoint(run))) return false;
        await session.emit({ kind: 'usage', turn: ++turn.n, ...usage });
        if (intervalMs) await sleep(intervalMs);
      }
      return true;
    }
    case 'quota':
      await session.emit({
        kind: 'quota_reading',
        reading: {
          model: null,
          percent: null,
          resetsAt: null,
          takenAt: new Date().toISOString(),
          source: 'fake',
          usingOverage: false,
          ...step.reading,
        },
      });
      return true;
    case 'permission': {
      const requestId = `perm-${run.answers.size + 1}-${Date.now()}`;
      await session.emit({ kind: 'permission_request', requestId, action: step.action, detail: step.detail });
      if (!(await until(run, () => run.answers.has(requestId)))) return false;
      await session.emit({ kind: 'progress', text: `permission ${run.answers.get(requestId)}` });
      return true;
    }
    case 'tool':
      for (let i = 0; step.times === 'forever' || i < step.times; i++) {
        if (i > 0 && !(await checkpoint(run))) return false;
        // Without an input each call differs (busy work); with one, every call is the same (a loop).
        await session.emit({ kind: 'progress', tool: { name: step.name, input: 'input' in step ? step.input : { call: i + 1 } } });
        if (step.intervalMs) await sleep(step.intervalMs);
      }
      return true;
    case 'ask': {
      const result = await callTool(run, 'raise_ask', step.ask);
      if (result.isError) throw new Error(`raise_ask failed: ${result.text}`);
      const ask = result.structured as { askId: string; blocking: boolean; recommendation: string };
      await session.emit({ kind: 'progress', text: `ask raised: ${ask.askId}`, tool: { name: 'kiln.raise_ask', input: step.ask } });
      if (!ask.blocking) {
        await session.emit({ kind: 'progress', text: `carrying on with: ${ask.recommendation}` });
        return true;
      }
      // Kiln pauses the Session (interrupt) and resumes it with the answer.
      run.awaiting.add(ask.askId);
      const answered = await until(run, () => run.askAnswers.has(ask.askId) && !run.paused);
      run.awaiting.delete(ask.askId);
      if (!answered) return false;
      await session.emit({ kind: 'progress', text: `answered: ${run.askAnswers.get(ask.askId)}` });
      return true;
    }
    case 'kiln_tools_list': {
      const { tools } = (await mcp(run, 'tools/list')) as { tools: { name: string }[] };
      await session.emit({ kind: 'progress', text: `tools: ${tools.map((tool) => tool.name).join(', ')}` });
      return true;
    }
    case 'kiln_tool': {
      const result = await callTool(run, step.name, step.input ?? {});
      await session.emit({
        kind: 'progress',
        text: result.isError ? `error: ${result.text}` : result.text,
        tool: { name: `kiln.${step.name}`, input: step.input },
      });
      return true;
    }
    case 'widget_ask': {
      const ask = await client.call<{ id: string }>('POST', '/api/widget/asks', step.ask);
      const heard = () => session.emit({ kind: 'progress', text: `widget heard: ${widgetAnswers.get(ask.id)}` });
      if (step.wait === false) {
        void until(run, () => widgetAnswers.has(ask.id)).then(async (answered) => {
          if (answered) await heard();
        });
        return true;
      }
      if (!(await until(run, () => widgetAnswers.has(ask.id)))) return false;
      await heard();
      return true;
    }
    case 'wait_for_message': {
      if (!(await until(run, () => run.texts.length > 0))) return false;
      await session.emit({ kind: 'progress', text: `heard: ${run.texts.shift()}` });
      return true;
    }
    case 'digest':
      await session.emit({ kind: 'digest_written', digest: step.text });
      return true;
    case 'report_seed': {
      const { sessionId, prompt, seed = {} } = session.start;
      await session.emit({ kind: 'progress', text: `seed: ${JSON.stringify({ sessionId, prompt, seed })}` });
      return true;
    }
    case 'finish':
      await session.emit({ kind: 'finished', reason: step.reason ?? 'completed', message: step.message });
      return false;
  }
}

async function runSession(run: Run) {
  const turn = { n: 0 };
  try {
    const steps = readScript(run.session.start.role, run.session.start.prompt);
    for (const [i, step] of steps.entries()) {
      if (!(await checkpoint(run))) return;
      const reason = step.do === 'finish' ? (step.reason ?? 'completed') : undefined;
      const continues = (reason === 'completed' || reason === 'interrupted') && i < steps.length - 1;
      if (!continues || step.do !== 'finish') {
        if (!(await perform(run, step, turn))) return;
        continue;
      }
      // A completed or interrupted finish with steps after it: the Session stays open, and the next
      // text message (a Thread message or Kiln's Exit feedback) continues it from the next step.
      await run.session.emit({ kind: 'finished', reason, message: step.message });
      if (!(await until(run, () => run.texts.length > 0))) return;
      await run.session.emit({ kind: 'progress', text: `heard: ${run.texts.shift()}` });
    }
    if (await checkpoint(run)) await run.session.emit({ kind: 'finished', reason: 'completed' });
  } catch (err) {
    if (!run.stopped) await run.session.emit({ kind: 'finished', reason: 'error', message: String(err) });
  } finally {
    runs.delete(run.session.start.sessionId);
  }
}

const withRun = (sessionId: string, act: (run: Run) => void) => {
  const run = runs.get(sessionId);
  if (!run) return;
  act(run);
  run.wake();
};

const agent: Agent = {
  startSession(session) {
    const run: Run = {
      session,
      paused: false,
      stopped: false,
      texts: [],
      answers: new Map(),
      askAnswers: new Map(),
      awaiting: new Set(),
      mcpReady: false,
      waiters: new Set(),
      wake() {
        const waiting = [...this.waiters];
        this.waiters.clear();
        for (const wake of waiting) wake();
      },
    };
    runs.set(session.start.sessionId, run);
    void runSession(run);
  },
  async sendMessage(sessionId, message: AgentMessage) {
    const run = runs.get(sessionId);
    if (message.kind === 'ask_answer' && run && !run.awaiting.has(message.askId)) {
      run.askAnswers.set(message.askId, message.answer);
      await run.session.emit({ kind: 'progress', text: `answer changed: ${message.answer}` });
      return;
    }
    withRun(sessionId, (run) => {
      if (message.kind === 'text') run.texts.push(message.text);
      else if (message.kind === 'ask_answer') run.askAnswers.set(message.askId, message.answer);
      else run.answers.set(message.requestId, message.decision);
    });
  },
  interrupt: (sessionId) => withRun(sessionId, (run) => (run.paused = true)),
  resume: (sessionId) => withRun(sessionId, (run) => (run.paused = false)),
  async stop(sessionId) {
    const run = runs.get(sessionId);
    if (!run || run.stopped) return;
    run.stopped = true;
    run.wake();
    await run.session.emit({ kind: 'finished', reason: 'stopped' });
  },
};

await serveAgent(agent, {
  client,
  // Sessions on Stages that name no model run `fake-model` (see FAKE_AGENT_MODEL in the harness).
  agents: [
    {
      id: 'fake',
      name: 'Fake Agent',
      cacheLifetimeMs: settings.cacheLifetimeMs ?? 300_000,
      ...(settings.model === null ? {} : { model: settings.model ?? 'fake-model' }),
      ...(settings.models ? { models: settings.models.map((id) => ({ id, name: id })) } : {}),
    },
  ],
  onAskAnswered(ask) {
    if (ask.answer === undefined) return;
    widgetAnswers.set(ask.id, ask.answer);
    for (const run of runs.values()) run.wake();
  },
});
