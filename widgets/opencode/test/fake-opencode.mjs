// A stand-in for `opencode serve` (OpenCode 1.x's HTTP server), for the OpenCode Widget's tests.
//
//   node fake-opencode.mjs <scenario.json> serve --port <n> --hostname <host>
//
// It serves the parts of the 1.x server API the Widget uses (health, /event, sessions, prompt_async,
// abort, permission replies), reads its config from OPENCODE_CONFIG_CONTENT as OpenCode does, checks
// OPENCODE_SERVER_PASSWORD, and plays the scenario's steps as the "model". It enforces the config's
// `permission` settings the way OpenCode does (last matching pattern wins), so what runs, what is
// refused and what asks is down to the Widget's translation of the Kiln Policy.
//
// Scenario: { steps: Step[], version?: string, permissionEvent?: 'asked' | 'updated',
// limits?: { "provider/model": contextWindow } }. Each prompt
// to the main session plays steps from where the last one stopped, up to an `end_turn` (or the end).
//   { do: 'text', text }
//   { do: 'usage', input, output, reasoning?, cacheRead?, cacheWrite?, cost? }   one model step (step-finish)
//   { do: 'bash', command }                 runs it in the server's directory, if permitted
//   { do: 'edit', path, content }           writes the file, if permitted
//   { do: 'webfetch', url }                 asks/refuses per config; never fetches
//   { do: 'mcp', tool, args }               calls a tool on the `kiln` MCP server from the config
//   { do: 'subagent', description, steps }  a child session (the task tool) playing its own steps
//   { do: 'wait', ms }                      busy for a while (an abort cuts it short)
//   { do: 'end_turn' }
//   { do: 'fail', message }                 the turn fails with session.error
//
// Logs, beside the scenario: <scenario>.configs.jsonl (one line per server: cwd, config),
// <scenario>.calls.jsonl (each API call) and <scenario>.tools.jsonl (each tool call and its outcome).
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { exec } from 'node:child_process';

const [scenarioFile, command] = process.argv.slice(2);
if (command !== 'serve') {
  process.stderr.write(`fake opencode: only "serve" is faked, not ${command}\n`);
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const password = process.env.OPENCODE_SERVER_PASSWORD;
const cwd = process.cwd();
const log = (kind, entry) => appendFileSync(`${scenarioFile}.${kind}.jsonl`, `${JSON.stringify(entry)}\n`);
log('configs', { cwd, config, password: Boolean(password) });

let ids = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(36)}${(++ids).toString().padStart(4, '0')}`;

// --- events ---------------------------------------------------------------------------------
const listeners = new Set();
const emit = (type, properties) => {
  const data = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of listeners) res.write(data);
};

// --- permissions, as OpenCode evaluates them -------------------------------------------------
const wildcard = (pattern, text) => {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  return re.test(text);
};
/** allow | ask | deny for one tool and pattern: the last matching entry wins; unset means allow. */
function permissionFor(tool, pattern) {
  const all = config.permission;
  if (typeof all === 'string') return all;
  const rule = all?.[tool] ?? all?.['*'];
  if (rule === undefined) return 'allow';
  if (typeof rule === 'string') return rule;
  let decision = 'allow';
  for (const [p, d] of Object.entries(rule)) if (wildcard(p, pattern)) decision = d;
  return decision;
}

const pendingPermissions = new Map(); // permission id -> resolve(response)

/** Waits for the reply to a permission OpenCode asks about; resolves 'once' | 'always' | 'reject' | 'aborted'. */
function askPermission(session, turn, tool, pattern, metadata, callID) {
  const permissionId = id('per');
  const answer = new Promise((done) => pendingPermissions.set(permissionId, done));
  turn.cancel.add(() => pendingPermissions.get(permissionId)?.('aborted'));
  if (scenario.permissionEvent === 'updated') {
    emit('permission.updated', {
      id: permissionId,
      type: tool,
      pattern,
      sessionID: session.id,
      messageID: turn.messageID,
      callID,
      title: tool === 'bash' ? pattern : `${tool} ${pattern}`,
      metadata,
      time: { created: Date.now() },
    });
  } else {
    emit('permission.asked', {
      id: permissionId,
      sessionID: session.id,
      permission: tool,
      patterns: [pattern],
      metadata,
      always: [pattern],
      tool: { messageID: turn.messageID, callID },
    });
  }
  return answer.then((response) => {
    pendingPermissions.delete(permissionId);
    emit('permission.replied', { sessionID: session.id, permissionID: permissionId, response });
    return response;
  });
}

/** Checks a tool call against the config; resolves true when it may run. */
async function permitted(session, turn, tool, pattern, metadata, callID) {
  const decision = permissionFor(tool, pattern);
  if (decision === 'allow') return 'ran';
  if (decision === 'deny') return 'denied';
  const response = await askPermission(session, turn, tool, pattern, metadata, callID);
  if (response === 'aborted') return 'aborted';
  return response === 'reject' ? 'rejected' : 'ran';
}

// --- the "model" ------------------------------------------------------------------------------
const sessions = new Map(); // id -> { id, parentID, title, cursor, steps, busy, queue, turn }

function newSession(parentID, title, steps) {
  const session = { id: id('ses'), parentID, title, directory: cwd, cursor: 0, steps, busy: false, queue: [], turn: null };
  sessions.set(session.id, session);
  const info = { id: session.id, parentID, title, directory: cwd, time: { created: Date.now(), updated: Date.now() } };
  emit('session.created', { info });
  return session;
}

const modelOf = (body) => {
  if (body?.model?.providerID) return { providerID: body.model.providerID, modelID: body.model.modelID };
  const [providerID, ...rest] = String(config.model ?? 'fake/fake-model').split('/');
  return { providerID, modelID: rest.join('/') };
};

function part(session, turn, fields) {
  const p = { id: fields.id ?? id('prt'), sessionID: session.id, messageID: turn.messageID, ...fields };
  emit('message.part.updated', { part: p });
  return p;
}

function assistantMessage(session, turn, done) {
  emit('message.updated', {
    info: {
      id: turn.messageID,
      sessionID: session.id,
      role: 'assistant',
      providerID: turn.model.providerID,
      modelID: turn.model.modelID,
      tokens: turn.tokens,
      cost: turn.cost,
      time: { created: turn.created, ...(done ? { completed: Date.now() } : {}) },
    },
  });
}

const sleep = (ms, turn) =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    turn.cancel.add(() => {
      clearTimeout(timer);
      done();
    });
  });

function runShell(commandLine) {
  return new Promise((done) => {
    // A git identity, as a real machine has, so a plain `git commit` works.
    const env = { ...process.env, GIT_AUTHOR_NAME: 'OpenCode', GIT_AUTHOR_EMAIL: 'opencode@kiln.invalid', GIT_COMMITTER_NAME: 'OpenCode', GIT_COMMITTER_EMAIL: 'opencode@kiln.invalid' };
    exec(commandLine, { cwd, env, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      done({ ok: !err, output: `${stdout}${stderr}${err && !stderr ? String(err) : ''}` }),
    );
  });
}

let mcpIds = 0;
async function mcpCall(tool, args) {
  const server = config.mcp?.kiln;
  if (!server || server.type !== 'remote') throw new Error('no remote "kiln" MCP server in the config');
  const send = async (message) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
    if (res.status === 202) return undefined;
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(`MCP ${message.method} -> ${res.status}: ${body.error?.message ?? ''}`);
    return body.result;
  };
  await send({ id: ++mcpIds, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-opencode', version: '1' } } });
  await send({ method: 'notifications/initialized' });
  const result = await send({ id: ++mcpIds, method: 'tools/call', params: { name: tool, arguments: args ?? {} } });
  return result.content.map((c) => c.text).join('\n');
}

/** One tool call: a running part, the permission check, then completed or error. */
async function tool(session, turn, name, input, pattern, metadata, run) {
  const callID = id('call');
  const base = { id: id('prt'), type: 'tool', tool: name, callID };
  part(session, turn, { ...base, state: { status: 'running', input, time: { start: Date.now() } } });
  const outcome = await permitted(session, turn, name, pattern, metadata, callID);
  if (outcome === 'aborted') return 'aborted';
  let output = '';
  let ok = outcome === 'ran';
  if (ok) ({ ok, output } = await run());
  log('tools', { session: session.id, tool: name, pattern, outcome, ok, output });
  const state = ok
    ? { status: 'completed', input, output, metadata: {}, title: pattern, time: { start: Date.now(), end: Date.now() } }
    : { status: 'error', input, error: outcome === 'ran' ? output : `The user ${outcome === 'denied' ? 'denied' : 'rejected'} permission to use this tool`, time: { start: Date.now(), end: Date.now() } };
  part(session, turn, { ...base, state });
  return outcome;
}

async function playStep(session, turn, step) {
  switch (step.do) {
    case 'text':
      part(session, turn, { type: 'text', text: step.text });
      return;
    case 'usage': {
      const tokens = { input: step.input, output: step.output, reasoning: step.reasoning ?? 0, cache: { read: step.cacheRead ?? 0, write: step.cacheWrite ?? 0 } };
      const cost = step.cost ?? 0;
      turn.tokens = {
        input: turn.tokens.input + tokens.input,
        output: turn.tokens.output + tokens.output,
        reasoning: turn.tokens.reasoning + tokens.reasoning,
        cache: { read: turn.tokens.cache.read + tokens.cache.read, write: turn.tokens.cache.write + tokens.cache.write },
      };
      turn.cost += cost;
      part(session, turn, { type: 'step-start' });
      part(session, turn, { type: 'step-finish', reason: 'tool-calls', tokens, cost });
      assistantMessage(session, turn, false);
      return;
    }
    case 'bash':
      return tool(session, turn, 'bash', { command: step.command, description: step.command }, step.command, { command: step.command }, () =>
        runShell(step.command),
      );
    case 'edit': {
      const target = resolve(cwd, step.path);
      return tool(session, turn, 'edit', { filePath: target, newString: step.content }, step.path, { filepath: target }, async () => {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, step.content);
        return { ok: true, output: '' };
      });
    }
    case 'webfetch':
      return tool(session, turn, 'webfetch', { url: step.url, format: 'text' }, step.url, { url: step.url }, async () => ({ ok: true, output: 'fetched' }));
    case 'mcp':
      return tool(session, turn, `kiln_${step.tool}`, step.args ?? {}, '*', {}, async () => {
        try {
          return { ok: true, output: await mcpCall(step.tool, step.args) };
        } catch (err) {
          return { ok: false, output: String(err) };
        }
      });
    case 'subagent': {
      const child = newSession(session.id, `${step.description} (@general subagent)`, step.steps);
      const callID = id('call');
      const base = { id: id('prt'), type: 'tool', tool: 'task', callID };
      const input = { description: step.description, prompt: step.description, subagent_type: 'general' };
      part(session, turn, { ...base, state: { status: 'running', input, metadata: { sessionId: child.id }, time: { start: Date.now() } } });
      await runTurn(child, {});
      part(session, turn, { ...base, state: { status: 'completed', input, output: 'done', metadata: { sessionId: child.id }, title: step.description, time: { start: Date.now(), end: Date.now() } } });
      return;
    }
    case 'wait':
      await sleep(step.ms, turn);
      return;
    case 'fail':
      throw Object.assign(new Error(step.message), { failed: true });
    default:
      throw new Error(`unknown step ${step.do}`);
  }
}

async function runTurn(session, body) {
  session.busy = true;
  const turn = {
    messageID: id('msg'),
    model: modelOf(body),
    created: Date.now(),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    aborted: false,
    cancel: new Set(),
  };
  session.turn = turn;
  emit('session.status', { sessionID: session.id, status: { type: 'busy' } });
  assistantMessage(session, turn, false);
  try {
    while (session.cursor < session.steps.length && !turn.aborted) {
      const step = session.steps[session.cursor];
      if (step.do === 'end_turn') {
        session.cursor++;
        break;
      }
      const outcome = await playStep(session, turn, step);
      // An aborted permission wait plays the step again on the next prompt.
      if (outcome !== 'aborted') session.cursor++;
    }
    assistantMessage(session, turn, true);
    if (turn.aborted) {
      emit('session.error', { sessionID: session.id, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } });
    }
  } catch (err) {
    session.cursor++;
    emit('session.error', { sessionID: session.id, error: { name: 'UnknownError', data: { message: err.message } } });
  }
  session.turn = null;
  session.busy = false;
  emit('session.status', { sessionID: session.id, status: { type: 'idle' } });
  emit('session.idle', { sessionID: session.id });
  const next = session.queue.shift();
  if (next) void runTurn(session, next);
}

// --- the HTTP API -----------------------------------------------------------------------------
const readBody = (req) =>
  new Promise((done) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => done(text ? JSON.parse(text) : undefined));
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * GET /config/providers as OpenCode serves it: { providers: [{ id, models: { [id]: { id, limit } } }], default }.
 * The catalogue is scenario.limits ("provider/model" -> context window) plus the config's own providers.
 */
const providers = () => {
  const byId = new Map();
  const add = (providerID, modelID, limit) => {
    if (!byId.has(providerID)) byId.set(providerID, { id: providerID, name: providerID, models: {} });
    byId.get(providerID).models[modelID] = { id: modelID, name: modelID, limit };
  };
  for (const [model, context] of Object.entries(scenario.limits ?? {})) {
    const at = model.indexOf('/');
    add(model.slice(0, at), model.slice(at + 1), { context, output: 4096 });
  }
  for (const [providerID, p] of Object.entries(config.provider ?? {})) {
    for (const [modelID, m] of Object.entries(p.models ?? {})) add(providerID, modelID, m.limit ?? { context: 0, output: 0 });
  }
  return { providers: [...byId.values()], default: {} };
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (password) {
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return json(res, 401, { error: 'unauthorized' });
  }
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  log('calls', { method: req.method, path: url.pathname, body, directory: req.headers['x-opencode-directory'] ?? url.searchParams.get('directory') });
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /global/health') return json(res, 200, { healthy: true, version: scenario.version ?? '1.14.0' });
  if (route === 'GET /config/providers') return json(res, 200, providers());
  if (route === 'GET /event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }
  if (route === 'POST /session') {
    const session = newSession(body?.parentID, body?.title ?? 'New session', scenario.steps ?? []);
    return json(res, 200, { id: session.id, title: session.title, directory: cwd });
  }
  let m = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const session = sessions.get(m[1]);
    if (!session) return json(res, 404, { error: 'no such session' });
    if (session.busy) session.queue.push(body);
    else void runTurn(session, body);
    res.writeHead(204).end();
    return;
  }
  m = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const session = sessions.get(m[1]);
    if (!session) return json(res, 404, { error: 'no such session' });
    for (const child of sessions.values()) {
      if (child.parentID === session.id && child.turn) child.turn.aborted = true;
    }
    if (session.turn) {
      session.turn.aborted = true;
      for (const s of sessions.values()) for (const cancel of s.turn?.cancel ?? []) cancel();
    }
    session.queue.length = 0;
    return json(res, 200, true);
  }
  m = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const done = pendingPermissions.get(m[2]);
    if (!done) return json(res, 404, { error: 'no such permission' });
    done(body?.response);
    return json(res, 200, true);
  }
  json(res, 404, { error: `fake opencode has no ${route}` });
});

const portArg = process.argv.indexOf('--port');
const hostArg = process.argv.indexOf('--hostname');
const host = hostArg > 0 ? process.argv[hostArg + 1] : '127.0.0.1';
server.listen(portArg > 0 ? Number(process.argv[portArg + 1]) : 4096, host, () => {
  process.stdout.write(`opencode server listening on http://${host}:${server.address().port}\n`);
});
