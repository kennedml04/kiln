// The Claude Code Agent Widget, driven from outside: installed from its folder through the normal
// install and approval flow, with the Claude Agent SDK replaced by the scripted fake in fake-sdk/
// (recorded SDK message shapes; no model is called and nothing is spent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRaisedEvent, BudgetInfo, ContextAlarmEvent, DigestWrittenEvent, ExitCheckedEvent, Item, ItemStageChangedEvent, Project, SessionAgentEvent, StartResult, UsageRecord, WidgetInfo } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { installClaudeCode } from './install.ts';

/** A Project whose tests pass only when `answer.txt` says 42; `git add` and `git commit` are known commands. */
function answerProject(kiln: TestKiln) {
  seedScratch(kiln.repo);
  writeRepoFile(
    kiln.repo,
    '.kiln/settings.json',
    JSON.stringify({ testCommand: 'node check-answer.mjs', knownCommands: ['git add *', 'git commit *'] }),
  );
  writeRepoFile(
    kiln.repo,
    'check-answer.mjs',
    "import { readFileSync } from 'node:fs';\nconst answer = readFileSync('answer.txt', 'utf8').trim();\nif (answer !== '42') {\n  console.error(`expected 42, got ${answer}`);\n  process.exit(1);\n}\n",
  );
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add the answer tests');
}

async function startTicket(kiln: TestKiln) {
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session, 'the Session starts at once');
  return { project, ticket, session, events };
}

const COMMIT = { tool: 'Bash', input: { command: 'git add -A && git commit -q -m "Answer"' } } as const;

test('a Ticket runs through Implementing with Claude Code in its worktree, gets Exit feedback, and moves to Review', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await installClaudeCode(t, kiln, {
    turns: [
      [{ tool: 'Write', input: { file_path: 'answer.txt', content: '41\n' } }, COMMIT, { assistant: { model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 1 }, costUsd: 0.004 } }, { text: 'Done.' }],
      [{ tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } }, COMMIT, { assistant: { model: 'claude-haiku-5-5', usage: { input_tokens: 20, output_tokens: 2 }, costUsd: 0.006 } }, { text: 'Fixed.' }],
    ],
  });
  const { ticket, session, events } = await startTicket(kiln);

  const first = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 });
  assert.equal(first.payload.exit.met, false);
  const second = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 });
  assert.equal(second.payload.exit.met, true);
  const moved = await events.next<ItemStageChangedEvent>('item.stage_changed', { timeoutMs: 20_000 });
  assert.deepEqual([moved.payload.itemId, moved.payload.to], [ticket.id, 'review']);
  assert.equal(kiln.repo.git('show', `${session.branch}:answer.txt`).trim(), '42');
  // One record per turn, each with its own cost (Claude Code reports cost cumulatively).
  const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
  assert.deepEqual(
    records.map((r) => [r.inputTokens, Math.round(r.costUsd! * 1e6) / 1e6]).sort(),
    [
      [10, 0.004],
      [20, 0.006],
    ],
  );
});

test("each turn's usage reaches Kiln's records, the main thread's and each subagent's (with its description), per model", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  const haiku = 'claude-haiku-5-5';
  await installClaudeCode(t, kiln, {
    turns: [
      [
        { subagent: { id: 'scout', description: 'Find the column code' } },
        { assistant: { model: haiku, subagent: 'scout', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.002 } },
        { assistant: { model: haiku, usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, costUsd: 0.003 } },
        { assistant: { model: 'claude-sonnet-5', usage: { input_tokens: 7, output_tokens: 3 }, costUsd: 0.01 } },
        { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
        COMMIT,
        { text: 'Done.' },
      ],
    ],
  });
  const { session, events } = await startTicket(kiln);
  await events.next('exit.checked', { timeoutMs: 20_000 });

  const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
  const shape = records
    .map((r) => [r.subagent, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.contextTokens])
    .sort((a, b) => String(a).localeCompare(String(b)));
  assert.deepEqual(shape, [
    ['Find the column code', haiku, 100, 20, 0, 0, 100],
    [null, 'claude-sonnet-5', 7, 3, 0, 0, 7],
    [null, haiku, 50, 10, 1000, 200, 1250],
  ].sort((a, b) => String(a).localeCompare(String(b))));
  const total = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  assert.ok(Math.abs(total - 0.015) < 1e-9, `the parts add up to what Claude Code measured: ${total}`);
  // Haiku's $0.005 split by token weight: the subagent 100 + 5*20 = 200, the main thread 50 + 5*10 + 0.1*1000 + 1.25*200 = 450.
  const scout = records.find((r) => r.subagent === 'Find the column code')!;
  assert.ok(Math.abs(scout.costUsd! - (0.005 * 200) / 650) < 1e-9, String(scout.costUsd));
  assert.equal(scout.parentSessionId, session.id);
});

test("each turn reports its model's context window, so Kiln's context alarm fires when a turn's context passes its share", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  // 700 tokens of context in a 1,000-token window is past the default share (0.6).
  await installClaudeCode(t, kiln, {
    contextWindow: 1_000,
    turns: [[{ assistant: { model: 'claude-haiku-5-5', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 600 }, costUsd: 0.001 } }, { text: 'Thinking.' }]],
  });
  const { session, events } = await startTicket(kiln);
  const alarm = await events.next<ContextAlarmEvent>('session.context_alarm', { timeoutMs: 20_000 });
  assert.deepEqual([alarm.payload.sessionId, alarm.payload.contextTokens, alarm.payload.threshold], [session.id, 700, 600]);
});

/** A `get_usage` reply shaped like the one docs/research/claude-code-quota-readings.md recorded. */
const usageReply = (weeklyPercent: number, usedCredits: number) => ({
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: weeklyPercent, resets_at: '2026-11-03T09:00:00.811315+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: '2026-11-03T08:59:59.811449+00:00' }],
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: usedCredits, utilization: 25.2, currency: 'USD' },
  },
  limits: [
    { kind: 'weekly_all', group: 'weekly', percent: weeklyPercent, severity: 'critical', resets_at: '2026-11-03T09:00:00.811315+00:00', scope: null, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      severity: 'critical',
      resets_at: '2026-11-03T08:59:59.811449+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: true,
    },
  ],
});

type QuotaEvent = SessionAgentEvent<'quota_reading'>;

test('Max plan quota readings reach Kiln at Session start and after each turn, normalised, with rate-limit events as a fallback and overage noticed', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await installClaudeCode(t, kiln, {
    usage: usageReply(93, 504),
    turns: [
      [
        { tool: 'Read', input: { file_path: 'check-answer.mjs' } },
        { rateLimit: { rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1793696400 } },
        { setUsage: usageReply(95, 510) },
        { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
        COMMIT,
        { text: 'Done.' },
      ],
    ],
  });
  const { session, events } = await startTicket(kiln);
  const readings = [];
  for (let i = 0; i < 5; i++) readings.push((await events.next<QuotaEvent>('session.quota_reading', { timeoutMs: 20_000 })).payload);

  assert.ok(readings.every((r) => r.sessionId === session.id));
  assert.ok(readings.every((r) => !Number.isNaN(Date.parse(r.reading.takenAt))));
  const shape = readings.map(({ reading: r }) => [r.window, r.model, r.percent, r.resetsAt, r.source, r.usingOverage].join(' ')).sort();
  assert.deepEqual(shape, [
    '5h  42 2026-11-03T09:00:00.000Z rate_limit_event false',
    'week  93 2026-11-03T09:00:00.811Z get_usage false',
    'week  95 2026-11-03T09:00:00.811Z get_usage true',
    'week Fable 100 2026-11-03T08:59:59.811Z get_usage false',
    'week Fable 100 2026-11-03T08:59:59.811Z get_usage true',
  ]);
});

/** A subscription Budget for the model the Widget runs, on a core clock just before the fixtures' resets. */
async function maxBudget(kiln: TestKiln) {
  await kiln.api('POST', '/api/test/clock', { now: '2026-11-02T12:00:00.000Z' });
  await kiln.api('PUT', '/api/budgets/max', { kind: 'subscription', name: 'Max', models: ['claude-haiku-5-5'] });
}
const windows = async (kiln: TestKiln) =>
  (await kiln.api<BudgetInfo[]>('GET', '/api/budgets')).find((b) => b.id === 'max')!.windows!.map((w) => [w.id, w.known, w.percent]);

test("the readings land in the subscription Budget's windows", async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await maxBudget(kiln);
  const resets = '2026-11-03T09:00:00+00:00';
  await installClaudeCode(
    t,
    kiln,
    {
      usage: {
        rate_limits_available: true,
        limits: [
          { kind: 'session', percent: 20, resets_at: resets },
          { kind: 'weekly_all', percent: 10, resets_at: resets },
        ],
      },
      turns: [[{ tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } }, COMMIT, { text: 'Done.' }]],
    },
    { model: 'claude-haiku-5-5' },
  );
  const { events } = await startTicket(kiln);
  await events.next('exit.checked', { timeoutMs: 20_000 });
  assert.deepEqual(await windows(kiln), [
    ['week', true, 10],
    ['5h', true, 20],
    ['fable', false, null],
  ]);
});

test('when Claude Code gives no quota reading (an API key login, say), none reaches Kiln, so the Budget shows the windows unknown', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  await maxBudget(kiln);
  await installClaudeCode(
    t,
    kiln,
    { usage: 'unavailable', turns: [[{ tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } }, COMMIT, { text: 'Done.' }]] },
    { quotaIntervalMs: 50, model: 'claude-haiku-5-5' },
  );
  const { events } = await startTicket(kiln);
  await events.next('exit.checked', { timeoutMs: 20_000 });
  await assert.rejects(events.next('session.quota_reading', { timeoutMs: 500 }));
  assert.deepEqual(await windows(kiln), [
    ['week', false, null],
    ['5h', false, null],
    ['fable', false, null],
  ]);
});

test('a Session uses the Kiln tools: it reads its Item, a blocking Ask pauses it until the answer comes back as a message, and it writes its Digest', async (t) => {
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });
  answerProject(kiln);
  const claude = await installClaudeCode(t, kiln, {
    turns: [
      [
        { tool: 'mcp__kiln__read_item', input: {} },
        {
          tool: 'mcp__kiln__raise_ask',
          input: { type: 'decision', question: 'Which answer?', why: 'The tests check it.', recommendation: '42', options: ['41', '42'], blocking: true },
        },
        { waitForInterrupt: true },
      ],
      [
        { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
        COMMIT,
        { tool: 'mcp__kiln__write_digest', input: { decided: ['The answer is 42'], changed: ['answer.txt'], open: [] } },
        { text: 'Done.' },
      ],
    ],
  });
  const { session, events } = await startTicket(kiln);

  const ask = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 20_000 })).payload.ask;
  assert.equal(ask.question, 'Which answer?');
  const paused = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 20_000 });
  assert.equal(paused.payload.reason, 'interrupted');
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: '42' });
  const digest = (await events.next<DigestWrittenEvent>('digest.written', { timeoutMs: 20_000 })).payload.digest;
  const exit = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 });

  assert.equal(exit.payload.exit.met, true);
  assert.deepEqual([digest.sessionId, digest.writtenBy, digest.decided], [session.id, 'session', ['The answer is 42']]);
  const log = claude.log();
  const read = log.find((e) => e.kind === 'mcp' && e.tool === 'read_item');
  assert.match(JSON.stringify(read), /Draw the columns/);
  const users = log.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
  assert.equal(users.length, 2);
  assert.match(users[1]!, new RegExp(`answered your Ask ${ask.id}: 42`));
  assert.ok(log.some((e) => e.kind === 'interrupt'));
});

const touch = (file: string) => ({ tool: 'Bash', input: { command: `node -e "require('fs').writeFileSync('${file}', 'x')"` } });

test('a shell command the Policy asks about becomes a Permission Ask; the tool waits for the answer, and Deny keeps it from running', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  const claude = await installClaudeCode(t, kiln, { turns: [[touch('denied.txt'), touch('allowed.txt'), { text: 'Done.' }]] });
  const { session, events } = await startTicket(kiln);

  const first = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 20_000 })).payload.ask;
  assert.equal(first.type, 'permission');
  assert.equal(first.permission?.action, 'other_commands');
  assert.match(first.permission!.detail, /denied\.txt/);
  assert.equal((await kiln.api<{ state: string }>('GET', `/api/sessions/${session.id}`)).state, 'waiting');
  assert.ok(!existsSync(join(session.worktree!, 'denied.txt')), 'the tool waits for the answer');
  await kiln.api('POST', `/api/asks/${first.id}/answer`, { answer: 'Deny' });

  const second = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 20_000 })).payload.ask;
  assert.match(second.permission!.detail, /allowed\.txt/);
  await kiln.api('POST', `/api/asks/${second.id}/answer`, { answer: 'Allow once' });
  await events.next('exit.checked', { timeoutMs: 20_000 });

  assert.ok(!existsSync(join(session.worktree!, 'denied.txt')), 'Deny is honoured');
  assert.ok(existsSync(join(session.worktree!, 'allowed.txt')), 'Allow once runs it');
  const tools = claude.log().filter((e) => e.kind === 'tool');
  assert.deepEqual(
    tools.map((e) => [e.outcome, e.via]),
    [
      ['denied', 'permission'],
      ['ran', 'permission'],
    ],
  );
});

test('what the Policy denies is blocked without an Ask, and what it allows runs without one', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  writeRepoFile(kiln.repo, '.kiln/policy.json', JSON.stringify({ actions: { network: 'deny', other_commands: 'ask', external_writes: 'ask' }, rules: [] }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Deny the network');
  const claude = await installClaudeCode(t, kiln, {
    turns: [
      [
        { tool: 'WebFetch', input: { url: 'https://example.com/page', prompt: 'read it' } },
        { tool: 'Bash', input: { command: 'git push origin main' } },
        { tool: 'Read', input: { file_path: 'check-answer.mjs' } },
        { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
        { tool: 'Bash', input: { command: 'node check-answer.mjs' } },
        COMMIT,
        { text: 'Done.' },
      ],
    ],
  });
  const { events } = await startTicket(kiln);
  const ask = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 20_000 })).payload.ask;
  assert.deepEqual([ask.permission?.action, ask.permission?.detail], ['external_writes', 'git push origin main']);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Deny' });
  const exit = await events.next<ExitCheckedEvent>('exit.checked', { timeoutMs: 20_000 });
  assert.equal(exit.payload.exit.met, true);

  assert.deepEqual(
    claude.log().flatMap((e) => (e.kind === 'tool' ? [[e.name, e.outcome, e.via]] : [])),
    [
      ['WebFetch', 'denied', 'hook'],
      ['Bash', 'denied', 'permission'],
      ['Read', 'ran', 'hook'],
      ['Write', 'ran', 'hook'],
      ['Bash', 'ran', 'hook'],
      ['Bash', 'ran', 'hook'],
    ],
  );
});

test('a running Session reads the quota at an interval, and on stop it closes Claude Code and finishes "stopped"', async (t) => {
  const kiln = await startTestKiln(t);
  answerProject(kiln);
  const claude = await installClaudeCode(t, kiln, { usage: usageReply(93, 0), turns: [[{ text: 'Looking.' }, { waitForInterrupt: true }]] }, { quotaIntervalMs: 100 });
  const { session, events } = await startTicket(kiln);
  // One weekly reading per poll: the start's, then the interval's while the turn runs.
  const weekly = async () => {
    for (;;) {
      const { payload } = await events.next<QuotaEvent>('session.quota_reading', { timeoutMs: 5_000 });
      if (!payload.reading.model) return payload;
    }
  };
  for (let i = 0; i < 3; i++) await weekly();
  assert.ok(!claude.log().some((e) => e.kind === 'close'));

  await kiln.api('POST', '/api/test/widgets/claude-code/commands', { type: 'agent.stop', sessionId: session.id });
  const finished = await events.next<SessionAgentEvent<'finished'>>('session.finished', { timeoutMs: 5_000 });
  assert.equal(finished.payload.reason, 'stopped');
  assert.ok(claude.log().some((e) => e.kind === 'close'), 'Claude Code is closed');
  assert.ok(!claude.log().some((e) => e.kind === 'interrupt'));
});

test("the Agent offers setup Claude's models by name, or the ones its config lists", async (t) => {
  const offered = async (config: Record<string, unknown>) => {
    const kiln = await startTestKiln(t);
    await installClaudeCode(t, kiln, { turns: [] }, config);
    return (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === 'claude-code')!.agents[0]!.models;
  };
  const models = await offered({});
  assert.ok(models?.some((m) => m.id === 'claude-opus-5-5' && m.name === 'Opus 5.5'));
  assert.ok(models?.every((m) => m.id.startsWith('claude-') && m.name));
  assert.deepEqual(await offered({ models: [{ id: 'claude-work-proxy', name: 'Work proxy' }] }), [{ id: 'claude-work-proxy', name: 'Work proxy' }]);
});
