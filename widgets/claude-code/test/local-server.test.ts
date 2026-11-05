// Claude Code against a local model server (llama-swap in front of llama-server), with no Anthropic
// login. Opt-in: it loads a model on the GPU, so run it only while the GPU is free:
//   KILN_REAL_LOCAL=1 node --test --test-timeout=900000 widgets/claude-code/test/local-server.test.ts
// Optional: KILN_LOCAL_BASE_URL (default http://127.0.0.1:1240), KILN_LOCAL_MODEL (the server's model
// id, default qwen-27b), KILN_LOCAL_CONTEXT (that model's context size, default 65536) and
// KILN_LOCAL_CLAUDE (the claude executable, default `claude` on PATH).
// Findings and the env each setting fixes: .scratch/local-first/issues/02-llama-swap-messages-check.md.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skip = process.env.KILN_REAL_LOCAL === '1' ? false : 'loads a local model on the GPU: set KILN_REAL_LOCAL=1 to run it';
const BASE_URL = process.env.KILN_LOCAL_BASE_URL ?? 'http://127.0.0.1:1240';
const MODEL = process.env.KILN_LOCAL_MODEL ?? 'qwen-27b';
const CONTEXT = process.env.KILN_LOCAL_CONTEXT ?? '65536';
const CLAUDE = process.env.KILN_LOCAL_CLAUDE ?? 'claude';
const TIMEOUT_MS = 900_000;

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const messagesRequest = (stream: boolean) =>
  fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'local-dummy' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      stream,
      tools: [WEATHER_TOOL],
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
    }),
  });

/**
 * The environment a local Claude Code run gets: no Anthropic key, login or Claude Code session
 * variables from the parent, a fresh config folder and home, the local server as the base URL, and
 * the settings the 02 check found Claude Code needs against llama-server.
 */
function localClaudeEnv(configDir: string, home: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(ANTHROPIC_|CLAUDE|KILN_)/i.test(key) && !/^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key),
  ) as [string, string][];
  return {
    ...Object.fromEntries(inherited),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'Local'),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: 'local-dummy',
    // Every model alias Claude Code might pick for a side call goes to the same local model.
    ANTHROPIC_SMALL_FAST_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    // Claude Code sends a mid-conversation {role:"system"} turn; Qwen's chat template raises
    // "System message must be at the beginning" and llama-server answers 500. Turn that off.
    CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system',
    // An unknown model is assumed to have a 200K window; tell Claude Code the real one so it compacts in time.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: CONTEXT,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_MAX_RETRIES: '1',
  };
}

async function tempDir(t: TestContext, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

test('POST /v1/messages answers a tool call in Anthropic shape', { skip, timeout: TIMEOUT_MS }, async () => {
  const res = await messagesRequest(false);
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { type: string; role: string; stop_reason: string; content: { type: string; name?: string; id?: string; input?: { city?: string } }[] };
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'tool_use');
  const call = body.content.find((block) => block.type === 'tool_use');
  assert.ok(call, JSON.stringify(body.content));
  assert.equal(call.name, 'get_weather');
  assert.ok(call.id);
  assert.match(call.input?.city ?? '', /paris/i);
});

test('streaming /v1/messages sends Anthropic events and a tool call as input_json_delta', { skip, timeout: TIMEOUT_MS }, async () => {
  const res = await messagesRequest(true);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = (await res.text())
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; index?: number; content_block?: { type: string; name?: string }; delta?: { type?: string; partial_json?: string; stop_reason?: string } });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'message_start');
  assert.equal(types.at(-1), 'message_stop');
  const start = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  assert.ok(start, types.join(' '));
  assert.equal(start.content_block?.name, 'get_weather');
  const json = events
    .filter((e) => e.index === start.index && e.delta?.type === 'input_json_delta')
    .map((e) => e.delta?.partial_json)
    .join('');
  assert.match((JSON.parse(json) as { city: string }).city, /paris/i);
  assert.equal(events.find((e) => e.type === 'message_delta')?.delta?.stop_reason, 'tool_use');
});

test('headless Claude Code with no login writes a function and a test and runs it', { skip, timeout: TIMEOUT_MS }, async (t) => {
  const configDir = await tempDir(t, 'kiln-local-cfg-');
  const home = await tempDir(t, 'kiln-local-home-');
  const repo = await tempDir(t, 'kiln-local-repo-');
  mkdirSync(join(home, 'AppData'));
  mkdirSync(join(home, 'Local'));
  writeFileSync(join(repo, 'package.json'), '{ "name": "local-check", "type": "module" }\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');

  const prompt =
    'Create sum.js exporting a function sum(a, b) that returns a + b, and sum.test.js that tests it with node:test and node:assert. Then run: node --test sum.test.js and tell me the result.';
  const child = spawn(CLAUDE, ['-p', prompt, '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash Edit Write Read Glob Grep'], {
    cwd: repo,
    env: localClaudeEnv(configDir, home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  const messages = out
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as { type: string; subtype?: string; is_error?: boolean; apiKeySource?: string; message?: { content?: { type: string; name?: string }[] } });
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  assert.equal(init?.apiKeySource, 'none', 'no Anthropic key or login reached the run');
  const result = messages.find((m) => m.type === 'result');
  assert.equal(code, 0, `${err}\n${out.slice(-2000)}`);
  assert.equal(result?.subtype, 'success', out.slice(-2000));
  assert.equal(result?.is_error, false);
  const tools = messages.flatMap((m) => (m.type === 'assistant' ? (m.message?.content ?? []) : [])).filter((b) => b.type === 'tool_use').map((b) => b.name);
  assert.ok(tools.includes('Bash'), `tool calls: ${tools.join(', ')}`);
  assert.ok(existsSync(join(repo, 'sum.js')) && existsSync(join(repo, 'sum.test.js')));
  // The test the model wrote passes when run here too.
  execFileSync(process.execPath, ['--test', 'sum.test.js'], { cwd: repo, stdio: 'pipe' });
});
