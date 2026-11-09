// Local Sessions (local-first Ticket 03): a Session whose model is a local variant runs Claude Code
// against the local server, with no Anthropic key, login or config folder, under the same Policy,
// Kiln tools and attribution settings as a cloud Session; its usage draws on the local Budget
// under the variant id. The Claude Agent SDK is the scripted fake and the local server is the fake
// llama-swap, so no model runs. The real run (KILN_REAL_LOCAL=1) is at the end of this file.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { AskRaisedEvent, ExitCheckedEvent, Item, LocalServerSettings, Project, StartResult, UsageRecord, Variant } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { agentContract } from '@kiln/testing/agent-contract';
import { startFakeLocalServer, type FakeLocalServer } from '@kiln/testing/fake-local-server';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import type { FakeLogEntry, FakeScenario, FakeStep } from './fake-sdk/scenario.ts';
import { installClaudeCode, installClaudeCodeWidget } from './install.ts';

/** The server serves the model as `Coder-Hand`; Kiln's variant id for it is `coder-hand`. */
const SERVER_MODEL = 'Coder-Hand';
const VARIANT = 'coder-hand';
/** The dummy token a local Session sends (any value does for llama-swap). */
const LOCAL_AUTH_TOKEN = 'kiln-local';
/** llama-server names the GGUF file as the model of each reply. */
const GGUF_MODEL = '/models/Coder-30B-Q4_K_M.gguf';
const CONFIG = `models:\n  ${SERVER_MODEL}:\n    cmd: llama-server --port \${PORT} -m ${GGUF_MODEL} -c 32768 -ngl 99 --jinja\n`;

/** Points Kiln at a fake llama-swap, enables its entry as a variant and puts it in a local Budget. */
async function localVariant(t: TestContext, kiln: TestKiln, enable = true): Promise<FakeLocalServer> {
  const fake = await startFakeLocalServer(t, { config: CONFIG, loadMs: 1, answerMs: 1 });
  fake.reply(SERVER_MODEL, { kind: 'text', text: 'OK' });
  await kiln.api<LocalServerSettings>('PUT', '/api/local-server', { configPath: fake.configPath, url: fake.url });
  if (enable) {
    const variant = await kiln.api<Variant>('POST', `/api/variants/${VARIANT}/enable`);
    assert.deepEqual([variant.id, variant.serverModelId, variant.settings.contextSize], [VARIANT, SERVER_MODEL, 32768]);
  }
  await kiln.api('PUT', '/api/budgets/home', { kind: 'local', name: 'Home GPU', models: [VARIANT] });
  return fake;
}

/** A Project whose tests pass when `answer.txt` says 42. */
function answerProject(kiln: TestKiln) {
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node check-answer.mjs', knownCommands: ['git add *', 'git commit *'] }));
  writeRepoFile(kiln.repo, 'check-answer.mjs', "import { readFileSync } from 'node:fs';\nif (readFileSync('answer.txt', 'utf8').trim() !== '42') process.exit(1);\n");
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the answer tests');
}

async function startTicket(kiln: TestKiln) {
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const started = await kiln.request<StartResult & { error?: string }>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  return { ticket, events, started };
}

const COMMIT = { tool: 'Bash', input: { command: 'git add -A && git commit -q -m "Answer"' } } as const;
/** One turn as a local model plays it: usage reported under the GGUF file, at a made-up price. */
const ANSWER_TURN: FakeStep[] = [
  { assistant: { model: GGUF_MODEL, usage: { input_tokens: 40, output_tokens: 24 }, costUsd: 0.14 } },
  { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
  COMMIT,
  { text: 'Done.' },
];

const optionsOf = (log: FakeLogEntry[]) => {
  const entry = log.find((e) => e.kind === 'options');
  assert.ok(entry && entry.kind === 'options', 'the SDK got its options');
  return entry;
};
const envOf = (options: Record<string, unknown>) => options.env as Record<string, string>;
/** The env's Anthropic and Claude Code variables. */
const claudeVars = (env: Record<string, string>) => Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE)/i.test(k)).sort();

test('a Session on a local variant runs Claude Code against the local server, with no Anthropic login and a fresh config folder', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  const fake = await localVariant(t, kiln);
  // The dollar cap is for cloud Sessions; a local Session's price is made up.
  const claude = await installClaudeCode(t, kiln, { turns: [ANSWER_TURN] }, { model: VARIANT, maxBudgetUsd: 0.5 });
  const { events, started } = await startTicket(kiln);
  assert.equal(started.status, 201, started.body.error);
  assert.equal(started.body.session?.model, VARIANT);
  assert.equal((await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 })).payload.exit.met, true);

  const log = claude.log();
  const { options, configDirFiles } = optionsOf(log);
  assert.equal(options.model, SERVER_MODEL, "Claude Code asks for the server's model id");
  assert.equal(options.maxBudgetUsd, undefined);
  const env = envOf(options);
  assert.deepEqual(
    Object.fromEntries(claudeVars(env).map((k) => [k, k === 'CLAUDE_CONFIG_DIR' ? '(folder)' : env[k]])),
    {
      ANTHROPIC_AUTH_TOKEN: LOCAL_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: fake.url,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: SERVER_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: SERVER_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: SERVER_MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: SERVER_MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
      CLAUDE_CODE_MODEL_CAPABILITIES: '-mid_conv_system',
      CLAUDE_CONFIG_DIR: '(folder)',
    },
    'no Anthropic key, login or other Claude Code variable reaches it',
  );
  assert.equal(env.DISABLE_TELEMETRY, '1');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('KILN_')), "no Kiln credential reaches it");
  const inData = relative(join(kiln.dataDir, 'widgets', 'claude-code', 'data'), env.CLAUDE_CONFIG_DIR!);
  assert.ok(inData && !inData.startsWith('..') && !isAbsolute(inData), `the config folder is under the Widget's data folder: ${env.CLAUDE_CONFIG_DIR}`);
  assert.deepEqual(configDirFiles, [], 'the config folder starts empty, so no saved login is found');

  // Every model call went to the local server, for the server's model id, with the dummy token.
  const calls = log.filter((e) => e.kind === 'api');
  assert.ok(calls.length > 0);
  for (const call of calls) assert.deepEqual([call.url, call.model, call.token, call.status], [`${fake.url}/v1/messages`, SERVER_MODEL, LOCAL_AUTH_TOKEN, 200]);
  const served = fake.requests().filter((r) => r.path === '/v1/messages');
  assert.equal(served.length, calls.length);
  assert.ok(served.every((r) => (r.body as { model: string }).model === SERVER_MODEL));
});

test("a local Session's usage draws on the local Budget, one turn per turn, under the variant id and with no dollar price", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await localVariant(t, kiln);
  const scenario: FakeScenario = {
    contextWindow: 32_768,
    turns: [
      [
        { subagent: { id: 'scout', description: 'Find the answer' } },
        { assistant: { model: GGUF_MODEL, subagent: 'scout', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.05 } },
        ...ANSWER_TURN,
      ],
    ],
  };
  await installClaudeCode(t, kiln, scenario, { model: VARIANT });
  const { events, started } = await startTicket(kiln);
  assert.equal(started.status, 201, started.body.error);
  await events.next('exit.checked', { timeoutMs: 20_000 });

  const session = started.body.session!;
  const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
  assert.deepEqual(
    records.map((r) => [r.subagent, r.model, r.budgetId, r.cost, r.unit, r.costUsd, r.inputTokens]).sort((a, b) => String(a).localeCompare(String(b))),
    [
      ['Find the answer', VARIANT, 'home', 1, 'turns', null, 100],
      [null, VARIANT, 'home', 1, 'turns', null, 40],
    ].sort((a, b) => String(a).localeCompare(String(b))),
  );
});

test("a local turn's context is its last model call's, though the server names its replies' model its own way", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await localVariant(t, kiln);
  // Three calls of 12K input in a 32K window: each is under the alarm's 60%, their sum is not.
  const call: FakeStep = { assistant: { model: GGUF_MODEL, usage: { input_tokens: 12_000, output_tokens: 50 }, costUsd: 0.01 } };
  await installClaudeCode(t, kiln, { contextWindow: 32_768, turns: [[call, call, call, ...ANSWER_TURN]] }, { model: VARIANT });
  const { events, started } = await startTicket(kiln);
  assert.equal(started.status, 201, started.body.error);
  assert.equal((await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 })).payload.exit.met, true, 'the context alarm left it alone');

  const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(started.body.session!.id)}`);
  assert.deepEqual(
    records.map((r) => [r.model, r.inputTokens, r.contextTokens, r.cost]),
    [[VARIANT, 3 * 12_000 + 40, 40, 1]],
    'one record for the turn, its context the last call',
  );
});

test('the Policy, Kiln tools and attribution settings of a local Session are those of a cloud Session', async (t) => {
  const cloudKiln = await startTestKiln(t);
  answerProject(cloudKiln);
  const cloud = await installClaudeCode(t, cloudKiln, { turns: [[{ text: 'Done.' }]] });
  const cloudRun = await startTicket(cloudKiln);
  assert.equal(cloudRun.started.status, 201);
  await cloudRun.events.next('exit.checked', { timeoutMs: 20_000 });

  const localKiln = await startTestKiln(t);
  answerProject(localKiln);
  await localVariant(t, localKiln);
  const local = await installClaudeCode(t, localKiln, { turns: [[{ text: 'Done.' }]] }, { model: VARIANT });
  const localRun = await startTicket(localKiln);
  assert.equal(localRun.started.status, 201);
  await localRun.events.next('exit.checked', { timeoutMs: 20_000 });

  const shape = (options: Record<string, unknown>) => {
    const { env: _env, model: _model, cwd: _cwd, mcpServers, systemPrompt, ...rest } = options;
    const kiln = (mcpServers as { kiln?: { type: string; url: string; headers: Record<string, string> } }).kiln;
    return { ...rest, kilnTools: kiln ? [kiln.type, Object.keys(kiln.headers)] : null, systemPrompt: (systemPrompt as { type: string; preset: string }).preset };
  };
  const cloudOptions = optionsOf(cloud.log()).options;
  const localOptions = optionsOf(local.log()).options;
  assert.deepEqual(shape(localOptions), shape(cloudOptions));
  assert.deepEqual(localOptions.settings, { attribution: { commit: '', pr: '' } });
  assert.deepEqual(localOptions.settingSources, []);
  // The cloud Session keeps its own login: nothing local leaks into it.
  const cloudEnv = envOf(cloudOptions);
  assert.equal(cloudEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(cloudEnv.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(cloudOptions.model, 'claude-haiku-5-5');
});

test("a disabled variant's Session doesn't start, and says why", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await localVariant(t, kiln);
  await kiln.api('POST', `/api/variants/${VARIANT}/disable`, { reason: 'Too slow' });
  await installClaudeCode(t, kiln, { turns: [ANSWER_TURN] }, { model: VARIANT });
  const { started } = await startTicket(kiln);
  assert.equal(started.status, 409);
  assert.match(started.body.error ?? '', /disabled: Too slow/);
});

// The shared Agent contract, unchanged, on a local variant: the fake SDK against the fake llama-swap.
const CONTRACT_COMMIT = { tool: 'Bash', input: { command: 'git add answer.txt && git commit -q -m "Answer"' } };

agentContract({
  name: 'Claude Code (fake SDK, local variant)',
  async install(t, kiln, task) {
    await localVariant(t, kiln);
    await installClaudeCode(
      t,
      kiln,
      {
        turns:
          task.kind === 'answer'
            ? [
                [
                  { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
                  CONTRACT_COMMIT,
                  { assistant: { model: GGUF_MODEL, usage: { input_tokens: 30, output_tokens: 5 }, costUsd: 0.001 } },
                  { tool: 'mcp__kiln__write_digest', input: { decided: ['The answer is 42'], changed: ['answer.txt'], open: [] } },
                  { text: 'Done.' },
                ],
              ]
            : [[{ tool: 'Bash', input: { command: task.command } }, { text: 'It was denied, so I stopped.' }]],
      },
      { model: VARIANT },
    );
  },
});

// The 02 check through the Widget: real Claude Code (the SDK's own, or KILN_LOCAL_CLAUDE) on a real
// local model behind llama-swap does the answer Ticket to its Exit, with its usage on the local
// Budget. It loads a model on the GPU, so it is opt-in and should run only while the GPU is free:
//   KILN_REAL_LOCAL=1 node --test --test-timeout=1800000 widgets/claude-code/test/local-session.test.ts
// KILN_LOCAL_BASE_URL (default http://127.0.0.1:1240), KILN_LOCAL_MODEL (the server's model id,
// default qwen-27b) and KILN_LOCAL_CONTEXT (its context size, default 65536) as in local-server.test.ts.
// Kiln reads a throwaway config file naming the model, never the server's own, so nothing is written there.
// Not the shared Agent contract: a local model looks around first (`ls -la`) however the Ticket is
// worded, so the contract's first Ask is never its command, and an unanswered Ask stalls it. Here the
// Project knows the usual read-only commands, and any other Ask is allowed once and printed.
const REAL_URL = process.env.KILN_LOCAL_BASE_URL ?? 'http://127.0.0.1:1240';
const REAL_MODEL = process.env.KILN_LOCAL_MODEL ?? 'qwen-27b';
const REAL_CONTEXT = process.env.KILN_LOCAL_CONTEXT ?? '65536';
const REAL_TICKET =
  '# 01: Draw the columns\n\n**What to build:** Write the single line `42` into the file `answer.txt` at the root of your worktree, then commit it with `git add answer.txt` and `git commit -m "Answer"`. Do nothing else: no other files.\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] answer.txt says 42\n';

test(
  'a real local model runs a Ticket to its Exit through the Widget, on the local Budget',
  { skip: process.env.KILN_REAL_LOCAL === '1' ? false : 'loads a local model on the GPU: set KILN_REAL_LOCAL=1 to run it', timeout: 1_500_000 },
  async (t) => {
    const kiln = await startTestKiln(t);
    seedScratch(kiln.repo);
    writeRepoFile(kiln.repo, '.scratch/home-board/issues/01-draw-the-columns.md', REAL_TICKET);
    const knownCommands = ['git *', 'ls*', 'dir*', 'pwd', 'cat *', 'type *', 'head *', 'tail *', 'find *', 'echo *', 'node check-answer.mjs'];
    writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node check-answer.mjs', knownCommands }));
    writeRepoFile(kiln.repo, 'check-answer.mjs', "import { existsSync, readFileSync } from 'node:fs';\nif (!existsSync('answer.txt') || readFileSync('answer.txt', 'utf8').trim() !== '42') process.exit(1);\n");
    kiln.repo.git('add', '.');
    kiln.repo.git('commit', '-q', '-m', 'Seed the answer Ticket');

    const configPath = join(tempDir(t, 'kiln-real-local'), 'config.yaml');
    writeFileSync(configPath, `models:\n  ${REAL_MODEL}:\n    cmd: llama-server --port \${PORT} -m /models/local.gguf -c ${REAL_CONTEXT}\n`);
    await kiln.api('PUT', '/api/local-server', { configPath, url: REAL_URL });
    const variant = await kiln.api<Variant>('POST', `/api/variants/${encodeURIComponent(REAL_MODEL)}/enable`);
    await kiln.api('PUT', '/api/budgets/home', { kind: 'local', name: 'Home GPU', models: [variant.id] });
    await installClaudeCodeWidget(kiln, { model: variant.id, ...(process.env.KILN_LOCAL_CLAUDE ? { claudePath: process.env.KILN_LOCAL_CLAUDE } : {}) });

    const asks = await kiln.events();
    let watching = true;
    const allowing = (async () => {
      while (watching) {
        const ask = await asks.next<AskRaisedEvent>('ask.raised', { timeoutMs: 900_000 }).catch(() => undefined);
        if (!ask || !watching) return;
        console.log(`allowed once: ${ask.payload.ask.permission?.detail ?? ask.payload.ask.type}`);
        await kiln.request('POST', `/api/asks/${ask.payload.ask.id}/answer`, { answer: 'Allow once' });
      }
    })();
    t.after(() => {
      watching = false;
      asks.close();
    });

    const { events, started } = await startTicket(kiln);
    assert.equal(started.status, 201, started.body.error);
    const session = started.body.session!;
    try {
      for (let i = 0; ; i++) {
        const checked = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 600_000 });
        if (checked.payload.exit.met) break;
        assert.ok(i < 2, `the Exit is met within three tries: ${JSON.stringify(checked.payload.exit)}`);
      }
    } catch (err) {
      // What the Session did, to tell a slow model from one going round in circles.
      const audit = await kiln.api<{ action: string; outcome: string; detail: unknown }[]>('GET', '/api/audit');
      for (const a of audit) console.log(`audit: ${a.action} ${a.outcome} ${JSON.stringify(a.detail)}`);
      const turns = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
      console.log(`turns: ${turns.length}; session: ${JSON.stringify(await kiln.api('GET', `/api/sessions/${encodeURIComponent(session.id)}`))}`);
      throw err;
    }
    assert.equal(kiln.repo.git('show', `${session.branch}:answer.txt`).trim(), '42');
    const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
    assert.ok(records.length > 0, 'usage reaches the records');
    for (const r of records) assert.deepEqual([r.model, r.budgetId, r.cost, r.unit, r.costUsd], [variant.id, 'home', 1, 'turns', null]);
    watching = false;
    asks.close();
    await allowing;
  },
);
