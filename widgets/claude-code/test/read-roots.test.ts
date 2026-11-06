// Read roots, the chat Policy and Monitor commands, through the Widget's own entry point (main.ts) with the fake SDK.
// A small stand-in core serves the Widget's command stream and sends it one Session start, as the
// core's Agent interface does; the fake SDK's log then shows which tool calls ran and which were denied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAT_POLICY, ORG_POLICY_DEFAULT, WIDGET_ENV, effectivePolicy, type PolicyLayer } from '@kiln/widget-sdk';
import { tempDir, type Cleanup } from '@kiln/testing';
import type { FakeLogEntry, FakeStep } from './fake-sdk/scenario.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Runs one Session on the Widget with `readRoots` and `policy`; resolves to what happened to each tool call. */
async function runSession(t: Cleanup, steps: FakeStep[], readRoots: string[], policy: ReturnType<typeof effectivePolicy>, folder: string) {
  const scenarioFile = join(tempDir(t, 'kiln-fake-claude'), 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify({ turns: [[...steps, { text: 'Done.' }]] }));
  const dataDir = tempDir(t, 'kiln-widget-data');
  let finished: () => void = () => {};
  const done = new Promise<void>((resolveDone) => (finished = resolveDone));
  const server = createServer((req, res) => {
    if (req.url === '/api/widget/commands') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const start = {
        type: 'agent.start_session',
        agentId: 'claude-code',
        session: { sessionId: 's-1', role: 'chat', model: 'claude-haiku-5-5', prompt: 'Answer the question.', worktree: folder, readRoots, policy },
      };
      setTimeout(() => res.write(`data: ${JSON.stringify(start)}\n\n`), 200);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/widget/agent-events' && /"finished"/.test(body)) finished();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, [join(HERE, '..', 'src', 'main.ts')], {
    env: {
      ...process.env,
      [WIDGET_ENV.apiUrl]: `http://127.0.0.1:${port}`,
      [WIDGET_ENV.widgetId]: 'claude-code',
      [WIDGET_ENV.token]: 'x',
      [WIDGET_ENV.dataDir]: dataDir,
      [WIDGET_ENV.config]: JSON.stringify({ sdkModule: pathToFileURL(join(HERE, 'fake-sdk', 'sdk.ts')).href, fakeScenario: scenarioFile, model: 'claude-haiku-5-5' }),
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill();
    server.close();
    server.closeAllConnections();
  });
  await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('Session did not finish')), 30_000))]);
  const logFile = `${scenarioFile}.log`;
  const log = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeLogEntry)
    : [];
  return log.flatMap((e) => (e.kind === 'tool' ? [[e.name, e.outcome]] : []));
}

const chatPolicy = (org: Partial<typeof ORG_POLICY_DEFAULT> = {}) =>
  effectivePolicy([{ actions: { ...ORG_POLICY_DEFAULT, ...org }, rules: [] } as PolicyLayer & { rules: [] }, CHAT_POLICY]);

test('a chat reads inside its read roots and nothing else: writes, shell, other folders and the scratch folder are denied', async (t) => {
  const base = tempDir(t, 'kiln-chat-roots');
  const [scratch, project, knowledge, other] = ['scratch', 'project', 'knowledge', 'other'].map((n) => join(base, n));
  for (const dir of [scratch, project, knowledge, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'project file');
  writeFileSync(join(knowledge, 'n.md'), 'note');
  writeFileSync(join(other, 'secret.txt'), 'secret');
  const outcomes = await runSession(
    t,
    [
      { tool: 'Read', input: { file_path: join(project, 'a.txt') } },
      { tool: 'Read', input: { file_path: join(knowledge, 'n.md') } },
      { tool: 'Read', input: { file_path: join(other, 'secret.txt') } },
      { tool: 'Write', input: { file_path: join(project, 'a.txt'), content: 'changed' } },
      { tool: 'Write', input: { file_path: join(scratch, 'new.txt'), content: 'x' } },
      { tool: 'Bash', input: { command: 'node -e "1"' } },
    ],
    [project, knowledge],
    chatPolicy(),
    scratch,
  );
  assert.deepEqual(outcomes, [
    ['Read', 'ran'],
    ['Read', 'ran'],
    ['Read', 'denied'],
    ['Write', 'denied'],
    ['Write', 'denied'],
    ['Bash', 'denied'],
  ]);
  assert.equal(readFileSync(join(project, 'a.txt'), 'utf8'), 'project file');
  assert.equal(existsSync(join(scratch, 'new.txt')), false);
});

test('the network is allowed in a chat, and denied when the Org layer denies it', async (t) => {
  const folder = tempDir(t, 'kiln-chat-scratch');
  const fetchStep: FakeStep = { tool: 'WebFetch', input: { url: 'https://example.com/page', prompt: 'read it' } };
  assert.deepEqual(await runSession(t, [fetchStep], [], chatPolicy(), folder), [['WebFetch', 'ran']]);
  assert.deepEqual(await runSession(t, [fetchStep], [], chatPolicy({ network: 'deny' }), folder), [['WebFetch', 'denied']]);
});

test('a Monitor command is judged like a Bash command, and a Stage that denies outside work gets no temp scratch', async (t) => {
  const folder = tempDir(t, 'kiln-monitor-wt');
  const elsewhere = join(tempDir(t, 'kiln-monitor-other'), 'x.txt');
  writeFileSync(elsewhere, 'x');
  const policy = effectivePolicy([{ actions: { ...ORG_POLICY_DEFAULT, other_commands: 'deny', outside_worktree: 'deny' }, rules: [] }]);
  const outcomes = await runSession(
    t,
    [
      { tool: 'Monitor', input: { command: 'until [ -s out.log ]; do sleep 1; done', description: 'wait' } },
      { tool: 'Monitor', input: { command: 'rm -rf out.log', description: 'clean' } },
      { tool: 'Read', input: { file_path: elsewhere } },
    ],
    [],
    policy,
    folder,
  );
  assert.deepEqual(outcomes, [
    ['Monitor', 'ran'],
    ['Monitor', 'denied'],
    ['Read', 'denied'],
  ]);
});
