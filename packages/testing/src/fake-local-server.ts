// A fake llama-swap for tests: it serves the models named in a YAML config file (read again on
// every request, as llama-swap does with --watch-config) and answers Anthropic Messages requests
// with a scripted reply per model. Served on 127.0.0.1 on a free port, so no test ever talks to a
// real local model server.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { onCleanup, tempDir, type Cleanup } from './harness.ts';
import { assertIsolated } from './isolation.ts';

/** How the fake answers a model's Messages requests. Default: `tool` (a call to the first tool offered). */
export type FakeModelReply =
  | { kind: 'tool' }
  /** A plain text answer, no tool call. */
  | { kind: 'text'; text?: string }
  /** The model fails to load: every request gets this status. */
  | { kind: 'error'; status: number; message: string };

export interface FakeLocalServerRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeLocalServer {
  /** The base URL, e.g. http://127.0.0.1:51234 (what `PUT /api/local-server` takes as `url`). */
  url: string;
  /** The config file it serves from (in a temp folder). */
  configPath: string;
  /** The config file's text now. */
  config(): string;
  /** A person edits the config by hand. */
  writeConfig(text: string): void;
  reply(modelId: string, reply: FakeModelReply): void;
  /** The model ids it serves now (the config's `models:` keys). */
  models(): string[];
  /** Every request it was sent, oldest first. */
  requests(): FakeLocalServerRequest[];
}

export interface FakeLocalServerOptions {
  /** The config file's first text. Default: an empty `models:`. */
  config?: string;
  /** How long a model takes to load on its first request after a config change. Default 30. */
  loadMs?: number;
  /** Output tokens a reply reports. Default 24. */
  outputTokens?: number;
  /** How long a loaded model takes to answer. Default 20. */
  answerMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeLocalServer(t: Cleanup, options: FakeLocalServerOptions = {}): Promise<FakeLocalServer> {
  const configPath = join(tempDir(t, 'kiln-fake-llama-swap'), 'config.yaml');
  writeFileSync(configPath, options.config ?? 'models:\n');
  const replies = new Map<string, FakeModelReply>();
  const log: FakeLocalServerRequest[] = [];
  const loaded = new Set<string>();
  let loadedFrom = readFileSync(configPath, 'utf8');

  const models = () => {
    const text = readFileSync(configPath, 'utf8');
    // A changed config stops every running model, as llama-swap's --watch-config does.
    if (text !== loadedFrom) {
      loaded.clear();
      loadedFrom = text;
    }
    const data = (parse(text) ?? {}) as { models?: Record<string, unknown> | null };
    return Object.keys(data.models ?? {});
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    log.push({ method: req.method ?? '', path, body });
    if (req.method === 'GET' && path === '/v1/models') {
      return send(res, 200, { object: 'list', data: models().map((id) => ({ id, object: 'model', owned_by: 'llama-swap' })) });
    }
    const unload = /^\/api\/models\/unload\/(.+)$/.exec(path);
    if (req.method === 'POST' && unload) {
      loaded.delete(decodeURIComponent(unload[1]!));
      return send(res, 200, { msg: 'ok' });
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      const request = body as { model?: string; max_tokens?: number; tools?: { name: string }[] };
      const model = String(request.model);
      if (!models().includes(model)) return send(res, 404, { error: `could not find suitable handler for ${model}` });
      const reply = replies.get(model) ?? { kind: 'tool' };
      if (reply.kind === 'error') return send(res, reply.status, { error: { type: 'api_error', message: reply.message } });
      if (!loaded.has(model)) {
        await sleep(options.loadMs ?? 30);
        loaded.add(model);
      }
      await sleep(options.answerMs ?? 20);
      const usage = { input_tokens: 40, output_tokens: request.max_tokens === 1 ? 1 : (options.outputTokens ?? 24) };
      const base = { id: `msg_fake_${log.length}`, type: 'message', role: 'assistant', model, usage };
      const tool = request.tools?.[0];
      if (reply.kind === 'tool' && tool) {
        return send(res, 200, { ...base, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_fake', name: tool.name, input: { path: 'README.md' } }] });
      }
      return send(res, 200, { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: reply.kind === 'text' ? (reply.text ?? 'OK') : 'OK' }] });
    }
    return send(res, 404, { error: `No route for ${req.method} ${path}` });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  assertIsolated({ port });
  onCleanup(t, 'stop the fake local server', () => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));

  return {
    url: `http://127.0.0.1:${port}`,
    configPath,
    config: () => readFileSync(configPath, 'utf8'),
    writeConfig: (text) => writeFileSync(configPath, text),
    reply: (modelId, reply) => void replies.set(modelId, reply),
    models,
    requests: () => [...log],
  };
}
