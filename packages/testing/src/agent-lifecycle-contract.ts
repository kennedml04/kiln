// The Agent lifecycle contract (ADR 0004), beside the core Agent contract in agent-contract.ts: what
// every Agent Widget must do across a Session's life (Exit feedback, Stop all and Resume, a resume
// after the cache lifetime, Allow once, subagents, Digests), driven from outside through a real
// core. Each Agent Widget's tests call `agentLifecycleContract` with a subject that installs it; the
// fake Agent runs it too (packages/testing/test/agent-lifecycle-contract.test.ts).
//
// Every case runs the seeded Ticket "Draw the columns" through Implementing. The Ticket's text says
// what to do, so a real Agent can follow it; a scripted Agent follows its script for the behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  AskRaisedEvent,
  Digest,
  ExitCheckedEvent,
  Item,
  KilnEvent,
  Project,
  SessionAgentEvent,
  SessionInfo,
  SessionMessageEvent,
  SessionStartedEvent,
  StartResult,
  UsageRecord,
} from '@kiln/widget-sdk';
import { startTestKiln, type Cleanup, type EventStream, type TestKiln } from './harness.ts';
import { seedScratch, writeRepoFile } from './scratch.ts';

/**
 * What the Agent is asked to do in one case. The Ticket text for each is in `TASKS`; a scripted
 * subject maps each to a script that does the same.
 *
 * - commit: write `contract.txt` saying `done` and commit it.
 * - commit_after_feedback: commit `contract.txt` saying `draft` and finish; then act on Kiln's feedback
 *   (the tests want `done`).
 * - slow_commit: run `node contract-wait.mjs` (it takes a while), then do as `commit`.
 * - run_command: run `node contract-ran.mjs` (it writes `ran.txt`), then do as `commit`, committing `ran.txt` too.
 * - subagent_commit: hand a look around the repo to a subagent, then do as `commit`.
 * - digest_commit: write a Digest with `write_digest` whose decided list has `contract`, then do as `commit`.
 */
export type LifecycleBehaviour = 'commit' | 'commit_after_feedback' | 'slow_commit' | 'run_command' | 'subagent_commit' | 'digest_commit';

export interface AgentLifecycleSubject {
  /** Shown in each test name. */
  name: string;
  /** Skips every case (e.g. a real run that is not opted into); a string says why. */
  skip?: string | boolean;
  /** Per case. Default 60 s. */
  timeoutMs?: number;
  /** How long to wait for any one event. Default 20 s. */
  eventTimeoutMs?: number;
  /**
   * Installs the Agent Widget in `kiln` and resolves once it is ready. Its Agent must be the only one
   * (or the first), and do `behaviour`. `cacheLifetimeMs` is the prompt-cache lifetime it registers.
   */
  install(t: Cleanup, kiln: TestKiln, behaviour: LifecycleBehaviour, options: { cacheLifetimeMs?: number }): Promise<void>;
  /** Runs after each case that passed, e.g. to hold a real run to its cost cap. */
  check?(kiln: TestKiln, item: Item): Promise<void>;
}

const COMMIT = 'Create the file `contract.txt` in the repository root containing the single line `done`, then commit it with git.';

const TASKS: Record<LifecycleBehaviour, string> = {
  commit: COMMIT,
  commit_after_feedback:
    'Create the file `contract.txt` in the repository root containing the single line `draft`, commit it with git, and finish. If Kiln tells you the tests fail, fix what it says and commit again.',
  slow_commit: `First run the command \`node contract-wait.mjs\` and wait for it to finish. Then: ${COMMIT}`,
  run_command: 'Run the command `node contract-ran.mjs` exactly as written (it creates `ran.txt`). Then create `contract.txt` in the repository root containing the single line `done`, and commit both files with git.',
  subagent_commit: `Use a subagent (the task tool) to list the files in the repository and report back. Then: ${COMMIT}`,
  digest_commit: `Write your Digest with the write_digest Kiln tool, with \`contract\` as the only decided entry. Then: ${COMMIT}`,
};

const TICKET_FILE = '.scratch/home-board/issues/01-draw-the-columns.md';

/** The Project's tests: `contract.txt` must say `done` (and `ran.txt` exist, for run_command). */
const checkScript = (needsRan: boolean) =>
  [
    "import { existsSync, readFileSync } from 'node:fs';",
    "const text = existsSync('contract.txt') ? readFileSync('contract.txt', 'utf8').trim() : '(missing)';",
    "if (text !== 'done') { console.error(`contract.txt must say done, not ${text}`); process.exit(1); }",
    needsRan ? "if (!existsSync('ran.txt')) { console.error('ran.txt is missing: run node contract-ran.mjs'); process.exit(1); }" : '',
    '',
  ].join('\n');

/** Registers the seeded Project with this case's Ticket text, tests and Policy; returns the Ticket. */
async function contractProject(kiln: TestKiln, behaviour: LifecycleBehaviour): Promise<Item> {
  seedScratch(kiln.repo);
  writeRepoFile(
    kiln.repo,
    TICKET_FILE,
    `# 01: Draw the columns\n\n**What to build:** ${TASKS[behaviour]}\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] contract.txt says done\n`,
  );
  writeRepoFile(kiln.repo, 'contract-check.mjs', checkScript(behaviour === 'run_command'));
  writeRepoFile(kiln.repo, 'contract-ran.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'ran\\n');\n");
  writeRepoFile(kiln.repo, 'contract-wait.mjs', 'setTimeout(() => {}, 15000);\n');
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node contract-check.mjs' }));
  // The Project template asks about other commands; git (to commit) and the wait script are allowed,
  // so only `node contract-ran.mjs` raises a Permission Ask.
  writeRepoFile(
    kiln.repo,
    '.kiln/policy.json',
    JSON.stringify({
      actions: { other_commands: 'ask', network: 'ask', external_writes: 'ask' },
      rules: [
        { action: 'other_commands', match: 'git *', decision: 'allow' },
        { action: 'other_commands', match: 'node contract-wait.mjs', decision: 'allow' },
      ],
    }),
  );
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'The contract Ticket');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns');
  assert.ok(ticket, 'the seeded Ticket is there');
  return ticket;
}

async function nextWhere<E extends KilnEvent>(events: EventStream, type: E['type'], timeoutMs: number, match: (e: E) => boolean): Promise<E> {
  for (;;) {
    const event = await events.next<E>(type, { timeoutMs });
    if (match(event)) return event;
  }
}

export function agentLifecycleContract(subject: AgentLifecycleSubject): void {
  const timeout = subject.timeoutMs ?? 60_000;
  const eventMs = subject.eventTimeoutMs ?? 20_000;

  const run = (name: string, behaviour: LifecycleBehaviour, body: (c: ContractCase) => Promise<void>, cacheLifetimeMs?: number) =>
    test(`Agent lifecycle contract (${subject.name}): ${name}`, { skip: subject.skip, timeout }, async (t) => {
      const kiln = await startTestKiln(t);
      await subject.install(t, kiln, behaviour, { cacheLifetimeMs });
      const ticket = await contractProject(kiln, behaviour);
      const events = await kiln.events();
      const started = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
      assert.ok(started.session, 'the Session starts at once');
      const c: ContractCase = {
        kiln,
        ticket,
        session: started.session,
        events,
        next: <E extends KilnEvent>(type: E['type'], match: (e: E) => boolean = () => true) => nextWhere<E>(events, type, eventMs, match),
        records: () => kiln.api<UsageRecord[]>('GET', `/api/usage/records?item=${encodeURIComponent(ticket.id)}`),
      };
      await body(c);
      await subject.check?.(kiln, ticket);
    });

  const exitOf = (c: ContractCase, sessionId = c.session.id) =>
    c.next<ExitCheckedEvent>('exit.checked', (e) => e.payload.sessionId === sessionId);

  run('a Session does its Ticket in its worktree, meets the Exit, and reports usage for every turn', 'commit', async (c) => {
    const exit = await exitOf(c);
    assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
    await c.next('item.stage_changed');
    const records = (await c.records()).filter((r) => r.sessionId === c.session.id);
    assert.ok(records.length >= 1, 'at least one turn is reported');
    assert.deepEqual(
      records.map((r) => r.turn),
      records.map((_, i) => i + 1),
      'turns are numbered from 1',
    );
    for (const r of records) {
      assert.ok(r.model, 'each turn names its model');
      assert.ok(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0, 'each turn reports its input');
    }
  });

  run("a Session hears Kiln's Exit feedback as a message and acts on it", 'commit_after_feedback', async (c) => {
    const first = await exitOf(c);
    assert.equal(first.payload.exit.met, false);
    const feedback = await c.next<SessionMessageEvent>('session.message', (e) => e.payload.sessionId === c.session.id);
    assert.equal(feedback.payload.from, 'kiln');
    assert.match(feedback.payload.text, /contract\.txt must say done/);
    const second = await exitOf(c);
    assert.equal(second.payload.exit.met, true, JSON.stringify(second.payload.exit.checks));
  });

  run('Stop all interrupts a Session, which stays resumable and finishes after Resume', 'slow_commit', async (c) => {
    await c.next<SessionAgentEvent<'usage'>>('session.usage', (e) => e.payload.sessionId === c.session.id);
    await c.kiln.api('POST', '/api/scheduler/stop-all');
    const finished = await c.next<SessionAgentEvent<'finished'>>('session.finished', (e) => e.payload.sessionId === c.session.id);
    assert.equal(finished.payload.reason, 'interrupted');
    const paused = (await c.kiln.api<Item[]>('GET', '/api/items')).find((i) => i.id === c.ticket.id)!;
    assert.equal(paused.run?.state, 'paused');

    await c.kiln.api('POST', '/api/scheduler/resume');
    const exit = await exitOf(c);
    assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
  });

  run(
    "once the Agent's cache lifetime has passed, Resume stops the paused Session and a fresh one does the work",
    'slow_commit',
    async (c) => {
      await c.next<SessionAgentEvent<'usage'>>('session.usage', (e) => e.payload.sessionId === c.session.id);
      await c.kiln.api('POST', '/api/scheduler/stop-all');
      await c.next<SessionAgentEvent<'finished'>>('session.finished', (e) => e.payload.sessionId === c.session.id);
      await new Promise((done) => setTimeout(done, 800));

      await c.kiln.api('POST', '/api/scheduler/resume');
      const fresh = await c.next<SessionStartedEvent>('session.started', (e) => e.payload.itemId === c.ticket.id && e.payload.sessionId !== c.session.id);
      assert.equal((await c.kiln.api<SessionInfo>('GET', `/api/sessions/${c.session.id}`)).state, 'stopped');
      const exit = await exitOf(c, fresh.payload.sessionId);
      assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
    },
    500,
  );

  run('a command the Policy asks about waits on a Permission Ask, and Allow once lets it run', 'run_command', async (c) => {
    const raised = await c.next<AskRaisedEvent>('ask.raised', (e) => e.payload.ask.type === 'permission');
    const ask: Ask = raised.payload.ask;
    assert.equal(ask.permission?.sessionId, c.session.id);
    assert.equal(ask.permission?.action, 'other_commands');
    assert.match(ask.permission?.detail ?? '', /^node contract-ran\.mjs$/);
    assert.equal((await c.kiln.api<SessionInfo>('GET', `/api/sessions/${c.session.id}`)).state, 'waiting', 'the Session waits on the Ask');

    await c.kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Allow once' });
    const exit = await exitOf(c);
    assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
  });

  run("a subagent's turns are reported against their parent Session", 'subagent_commit', async (c) => {
    const exit = await exitOf(c);
    assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
    const sub = (await c.records()).filter((r) => r.parentSessionId === c.session.id);
    assert.ok(sub.length >= 1, 'a subagent turn is recorded');
    for (const r of sub) {
      assert.ok(r.subagent, 'it says which subagent');
      assert.ok(r.sessionId.startsWith(`${c.session.id}/`));
    }
  });

  run('a Session reaches its Kiln tools and leaves a Digest', 'digest_commit', async (c) => {
    const exit = await exitOf(c);
    assert.equal(exit.payload.exit.met, true, JSON.stringify(exit.payload.exit.checks));
    const digests = await c.kiln.api<Digest[]>('GET', `/api/items/${encodeURIComponent(c.ticket.id)}/digests`);
    assert.ok(
      digests.some((d) => d.writtenBy === 'session' && d.decided.includes('contract')),
      JSON.stringify(digests),
    );
  });
}

interface ContractCase {
  kiln: TestKiln;
  ticket: Item;
  session: SessionInfo;
  events: EventStream;
  next<E extends KilnEvent>(type: E['type'], match?: (e: E) => boolean): Promise<E>;
  records(): Promise<UsageRecord[]>;
}
