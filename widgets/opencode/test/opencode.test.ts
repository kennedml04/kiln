// The OpenCode Widget beyond the shared contract: how the Kiln Policy reaches OpenCode, Permission
// Asks, and usage on metered and local Budgets. `opencode` is faked by fake-opencode.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask, AskRaisedEvent, AuditEntry, ContextAlarmEvent, Item, PolicyLayer, Project, SessionAgentEvent, SessionInfo, StartResult, UsageRecord, WidgetInfo } from '@kiln/widget-sdk';
import { startTestKiln, type Cleanup, type EventStream, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { fakeOpenCode, installOpenCode, type FakeScenario } from './support.ts';

const MODEL = 'fakeai/cheap-1';

interface Setup {
  scenario: FakeScenario;
  config?: Record<string, unknown>;
  policy?: PolicyLayer;
  settings?: Record<string, unknown>;
  budgets?: Record<string, Record<string, unknown>>;
}

/** A Kiln with the OpenCode Widget, the seeded Project and its Ticket's Session started. */
async function ticketSession(t: Cleanup, setup: Setup) {
  const kiln = await startTestKiln(t);
  const opencode = fakeOpenCode(t, setup.scenario);
  await installOpenCode(t, kiln, { opencode: opencode.command, model: MODEL, ...setup.config });
  for (const [id, budget] of Object.entries(setup.budgets ?? {})) await kiln.api('PUT', `/api/budgets/${id}`, budget);
  seedScratch(kiln.repo);
  if (setup.policy) writeRepoFile(kiln.repo, '.kiln/policy.json', JSON.stringify(setup.policy));
  if (setup.settings) writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify(setup.settings));
  writeRepoFile(kiln.repo, 'contract-ran.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'ran\\n');\n");
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Setup');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session);
  return { kiln, opencode, ticket, session, events };
}

const finished = async (events: EventStream, sessionId: string) => {
  for (;;) {
    const e = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 20_000 });
    if (e.payload.sessionId === sessionId) return e.payload;
  }
};

const permissionAsk = async (events: EventStream): Promise<Ask> =>
  (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 20_000 })).payload.ask;

const records = (kiln: TestKiln, session: SessionInfo) => kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${session.id}`);

test("the Session's OpenCode runs in its worktree under its Policy, translated into OpenCode permissions, with its Kiln tools", async (t) => {
  const { opencode, session, events, kiln } = await ticketSession(t, {
    scenario: { steps: [{ do: 'usage', input: 10, output: 1 }] },
    policy: {
      actions: { other_commands: 'ask', network: 'deny', external_writes: 'ask' },
      rules: [
        { action: 'other_commands', match: 'git *', decision: 'allow' },
        { action: 'other_commands', match: 'rm *', decision: 'deny' },
      ],
    },
    settings: { testCommand: 'npm test' },
  });
  await finished(events, session.id);

  const [server] = opencode.configs();
  assert.ok(server, 'one server started');
  assert.equal(server.cwd.toLowerCase(), session.worktree!.toLowerCase());
  assert.equal(server.password, true, 'the server has its own password');
  assert.equal(server.config.model, MODEL);
  assert.deepEqual(server.config.permission, {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    edit: 'allow',
    bash: {
      '*': 'ask',
      'npm test': 'allow',
      'npm test *': 'allow',
      'git *': 'allow',
      'git push': 'ask',
      'git push *': 'ask',
      'gh pr': 'ask',
      'gh pr *': 'ask',
      'gh issue': 'ask',
      'gh issue *': 'ask',
      'gh release': 'ask',
      'gh release *': 'ask',
      'gh api': 'ask',
      'gh api *': 'ask',
      'gh repo': 'ask',
      'gh repo *': 'ask',
      'gh gist': 'ask',
      'gh gist *': 'ask',
      'rm *': 'deny',
    },
    webfetch: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    external_directory: 'ask',
    doom_loop: 'allow',
    question: 'deny',
    task: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    skill: 'allow',
    lsp: 'allow',
  });
  assert.equal(server.config.mcp.kiln.type, 'remote');
  assert.ok(String(server.config.mcp.kiln.url).startsWith(kiln.url), server.config.mcp.kiln.url);
  assert.ok(Object.keys(server.config.mcp.kiln.headers).length > 0, 'it carries the Session credential');
  const prompt = opencode.calls().find((c) => c.path.endsWith('/prompt_async'))!;
  assert.deepEqual(prompt.body.model, { providerID: 'fakeai', modelID: 'cheap-1' });
  assert.match(prompt.body.parts[0].text, /Draw the columns/);
});

test('what the Policy denies OpenCode refuses itself, with no Ask', async (t) => {
  const { opencode, session, events, kiln } = await ticketSession(t, {
    scenario: { steps: [{ do: 'bash', command: 'git push origin main' }, { do: 'usage', input: 10, output: 1 }] },
    settings: { localOnly: true },
  });
  assert.equal((await finished(events, session.id)).reason, 'completed');
  assert.deepEqual(
    opencode.tools().map((x) => [x.tool, x.pattern, x.outcome]),
    [['bash', 'git push origin main', 'denied']],
  );
  assert.deepEqual(await kiln.api<Ask[]>('GET', '/api/asks?state=all'), []);
});

test('Deny on a Permission Ask refuses the command, and OpenCode waits for the answer before running anything', async (t) => {
  const { opencode, session, events, kiln, ticket } = await ticketSession(t, {
    scenario: { steps: [{ do: 'bash', command: 'node contract-ran.mjs' }, { do: 'usage', input: 10, output: 1 }] },
  });
  const ask = await permissionAsk(events);
  assert.deepEqual([ask.permission?.action, ask.permission?.detail], ['other_commands', 'node contract-ran.mjs']);
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(opencode.tools(), [], 'nothing has run while the Ask is open');
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${session.id}`)).state, 'waiting');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Deny' });
  assert.equal((await finished(events, session.id)).reason, 'completed');
  assert.deepEqual(opencode.tools().map((x) => x.outcome), ['rejected']);
  assert.ok(!existsSync(join(session.worktree!, 'ran.txt')));
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit');
  assert.ok(audit.some((e) => e.action === 'permission.deny' && e.target === `item:${ticket.id}`));
});

test("Kiln answers OpenCode's request from the Policy where OpenCode can't tell domains apart, and asks only about the rest", async (t) => {
  const { opencode, session, events, kiln } = await ticketSession(t, {
    scenario: {
      steps: [
        { do: 'webfetch', url: 'https://registry.npmjs.org/react' },
        { do: 'webfetch', url: 'https://evil.example/x' },
        { do: 'usage', input: 10, output: 1 },
      ],
    },
    policy: { actions: { network: 'ask' }, rules: [{ action: 'network', match: 'registry.npmjs.org', decision: 'allow' }] },
  });
  const ask = await permissionAsk(events);
  assert.deepEqual([ask.permission?.action, ask.permission?.detail], ['network', 'evil.example']);
  assert.deepEqual(opencode.tools().map((x) => [x.pattern, x.outcome]), [['https://registry.npmjs.org/react', 'ran']]);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Allow once' });
  await finished(events, session.id);
  assert.deepEqual(opencode.tools().map((x) => x.outcome), ['ran', 'ran']);
});

test("OpenCode's older permission event is handled the same way", async (t) => {
  const { session, events, kiln, opencode } = await ticketSession(t, {
    scenario: { permissionEvent: 'updated', steps: [{ do: 'bash', command: 'node contract-ran.mjs' }] },
  });
  const ask = await permissionAsk(events);
  assert.equal(ask.permission?.detail, 'node contract-ran.mjs');
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Allow once' });
  await finished(events, session.id);
  assert.deepEqual(opencode.tools().map((x) => x.outcome), ['ran']);
  assert.ok(existsSync(join(session.worktree!, 'ran.txt')));
});

test('each model step is a turn on the metered Budget its model belongs to, with the cost OpenCode reported', async (t) => {
  const { kiln, session, events } = await ticketSession(t, {
    scenario: {
      steps: [
        { do: 'usage', input: 1200, output: 80, reasoning: 20, cacheRead: 300, cacheWrite: 50, cost: 0.002 },
        { do: 'subagent', description: 'Read the docs', steps: [{ do: 'usage', input: 400, output: 30, cost: 0.001 }] },
        { do: 'usage', input: 100, output: 10, cost: 0.0005 },
      ],
    },
    budgets: { work: { kind: 'metered', name: 'Work', models: [MODEL], unit: 'USD', ratePerUsd: 1 } },
  });
  await finished(events, session.id);
  const all = await records(kiln, session);
  assert.deepEqual(
    all.map((r) => [r.sessionId, r.parentSessionId, r.subagent, r.turn, r.model, r.budgetId, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.costUsd, r.cost]),
    [
      [session.id, null, null, 1, MODEL, 'work', 1200, 100, 300, 50, 0.002, 0.002],
      [all[1]!.sessionId, session.id, 'Read the docs', 1, MODEL, 'work', 400, 30, 0, 0, 0.001, 0.001],
      [session.id, null, null, 2, MODEL, 'work', 100, 10, 0, 0, 0.0005, 0.0005],
    ],
  );
  assert.ok(all[1]!.sessionId.startsWith(`${session.id}/`));
});

test('pointed at a local model server, a Session runs on the local Budget and reports no cost', async (t) => {
  const { kiln, session, events, opencode } = await ticketSession(t, {
    scenario: { steps: [{ do: 'usage', input: 900, output: 60, cost: 0 }] },
    config: { model: 'homegpu/qwen3-coder', local: { homegpu: { baseURL: 'http://127.0.0.1:9/v1', models: ['qwen3-coder'] } } },
    budgets: { home: { kind: 'local', name: 'Home GPU', models: ['homegpu/qwen3-coder'] } },
  });
  await finished(events, session.id);
  assert.equal(session.model, 'homegpu/qwen3-coder');
  const [record] = await records(kiln, session);
  assert.deepEqual(
    [record!.model, record!.budgetId, record!.unit, record!.cost, record!.costUsd, record!.inputTokens],
    ['homegpu/qwen3-coder', 'home', 'turns', 1, null, 900],
  );
  assert.deepEqual(opencode.configs()[0]!.config.provider, {
    homegpu: { npm: '@ai-sdk/openai-compatible', name: 'homegpu', options: { baseURL: 'http://127.0.0.1:9/v1' }, models: { 'qwen3-coder': { name: 'qwen3-coder' } } },
  });
});

const contextAlarm = async (events: EventStream, sessionId: string) => {
  for (;;) {
    const e = await events.next<ContextAlarmEvent>('session.context_alarm', { timeoutMs: 20_000 });
    if (e.payload.sessionId === sessionId) return e.payload;
  }
};

test("the model's context window, as OpenCode knows it, reaches Kiln, so the context alarm fires at its share of it", async (t) => {
  const { session, events } = await ticketSession(t, {
    scenario: { limits: { [MODEL]: 10_000 }, steps: [{ do: 'usage', input: 7_000, output: 10 }, { do: 'wait', ms: 5_000 }] },
  });
  const alarm = await contextAlarm(events, session.id);
  assert.deepEqual([alarm.contextTokens, alarm.threshold], [7_000, 6_000]);
});

test("a local model's context window comes from the Widget's setting for it", async (t) => {
  const { session, events, opencode } = await ticketSession(t, {
    scenario: { steps: [{ do: 'usage', input: 5_000, output: 10 }, { do: 'wait', ms: 5_000 }] },
    config: { model: 'homegpu/qwen3-coder', local: { homegpu: { baseURL: 'http://127.0.0.1:9/v1', models: ['qwen3-coder'], contextWindow: 8_000 } } },
    budgets: { home: { kind: 'local', name: 'Home GPU', models: ['homegpu/qwen3-coder'] } },
  });
  const alarm = await contextAlarm(events, session.id);
  assert.deepEqual([alarm.contextTokens, alarm.threshold], [5_000, 4_800]);
  assert.deepEqual(opencode.configs()[0]!.config.provider.homegpu.models['qwen3-coder'].limit.context, 8_000);
});

test('an OpenCode whose server API this Widget does not speak ends the Session with an error saying so', async (t) => {
  const { session, events } = await ticketSession(t, { scenario: { version: '2.2.5', steps: [] } });
  const end = await finished(events, session.id);
  assert.equal(end.reason, 'error');
  assert.match(end.message ?? '', /OpenCode 2\.2\.5 is not supported.*1\.x/);
});

test('the Agent offers setup its model and every local server model, by the names it reports usage under', async (t) => {
  const kiln = await startTestKiln(t);
  const opencode = fakeOpenCode(t, { steps: [] });
  const local = { homegpu: { baseURL: 'http://127.0.0.1:9/v1', models: ['qwen3-coder', 'gemma-4'], name: 'Home GPU' } };
  await installOpenCode(t, kiln, { opencode: opencode.command, model: MODEL, local });
  const widgets = await kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  assert.deepEqual(widgets.find((w) => w.id === 'opencode')!.agents[0]!.models, [
    { id: MODEL },
    { id: 'homegpu/qwen3-coder', name: 'qwen3-coder (Home GPU)', local: true },
    { id: 'homegpu/gemma-4', name: 'gemma-4 (Home GPU)', local: true },
  ]);
});
