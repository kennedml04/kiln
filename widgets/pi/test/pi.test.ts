// The Pi Agent Widget, driven from outside: installed from its folder through the normal install and
// approval flow. Pi itself is real; the model is a scripted OpenAI-compatible server on a free port
// (what LM Studio looks like to Pi), so nothing is spent and no real model runs.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Item, Project, SessionAgentEvent, StartResult } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const WIDGET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'fake-local';

/** An OpenAI-compatible chat server that answers every request with `reply` and records the requests. */
async function fakeModelServer(t: TestContext, reply: string) {
  const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null = null, usage?: object) =>
        `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      res.write(chunk({ role: 'assistant', content: reply }));
      res.write(chunk({}, 'stop'));
      res.write(chunk({}, null, { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => void server.close());
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, requests };
}

async function installPi(kiln: TestKiln, config: Record<string, unknown>) {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: WIDGET_DIR, config });
  await kiln.api('POST', '/api/widgets/pi/approve');
  await events.next('widget.ready', { timeoutMs: 30_000 });
  events.close();
}

async function startTicket(kiln: TestKiln) {
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session, 'the Session starts at once');
  return { session, events };
}

test('a Session runs in its worktree on a local model, with only the worktree\'s context files, and finishes on agent_settled', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, 'AGENTS.md', 'WORKTREE-AGENTS-RULE: always say please.\n');
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add AGENTS.md');
  // A person's own Pi setup, which must not reach the Session.
  const userPi = tempDir(t, 'kiln-user-pi');
  writeFileSync(join(userPi, 'AGENTS.md'), 'USER-LEVEL-RULE: never load me.\n');
  mkdirSync(join(userPi, 'extensions'), { recursive: true });
  writeFileSync(join(userPi, 'extensions', 'canary.ts'), "export default function () { throw new Error('user extension loaded'); }\n");
  process.env.PI_CODING_AGENT_DIR = userPi;
  t.after(() => delete process.env.PI_CODING_AGENT_DIR);

  const model = await fakeModelServer(t, 'All done.');
  await installPi(kiln, { model: MODEL, models: [{ id: MODEL, contextWindow: 32768 }], localBaseUrl: model.url });
  const { session, events } = await startTicket(kiln);

  const done = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 60_000 });
  assert.equal(done.payload.sessionId, session.id);
  assert.equal(done.payload.reason, 'completed');

  assert.ok(model.requests.length >= 1);
  const first = model.requests[0];
  assert.equal(first.model, MODEL);
  const prompt = JSON.stringify(first.messages);
  assert.match(prompt, /WORKTREE-AGENTS-RULE/);
  assert.doesNotMatch(prompt, /USER-LEVEL-RULE/);
  assert.match(prompt, /Kiln's implementer Agent/);
});

test('a metered model without its apiKey secret fails the Session with a message, not silently', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  await installPi(kiln, { model: 'gpt-metered', models: [{ id: 'gpt-metered', provider: 'openai', providerModelId: 'gpt-5-mini' }] });
  const { events } = await startTicket(kiln);
  const done = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 60_000 });
  assert.equal(done.payload.reason, 'error');
  assert.match(done.payload.message ?? '', /apiKey/);
});
