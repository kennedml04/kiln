// The shared Agent contract: what every Agent Widget must do for Kiln, driven from outside through
// a real core. Each Agent Widget's own tests call `agentContract(subject)`; the subject installs
// its Widget ready for each task. A scripted Agent plays the task; a real one reads it from the
// Ticket, which spells it out (a tiny task, so a real run costs a few cents).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRaisedEvent, DigestWrittenEvent, ExitCheckedEvent, Item, ItemStageChangedEvent, Project, SessionAgentEvent, StartResult, UsageRecord } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from './harness.ts';
import { writeRepoFile } from './scratch.ts';

/** What the Agent is asked to do. */
export type AgentContractTask =
  /** Write `42` into `answer.txt` at the worktree root, commit it with git, write a Digest. */
  | { kind: 'answer' }
  /** Run `command` once (the Policy asks about it, and the person denies it), then stop. */
  | { kind: 'refused_command'; command: string };

export interface AgentContractSubject {
  /** Names the tests: "<name> keeps the Agent contract: …". */
  name: string;
  /** A reason to skip the whole contract (a paid run nobody asked for, say). */
  skip?: string | false;
  /** How long one test may take; a real Agent needs longer than a scripted one. */
  timeoutMs?: number;
  /** Installs, approves and starts the Agent Widget in this core, ready to do `task`. */
  install(t: TestContext, kiln: TestKiln, task: AgentContractTask): Promise<void>;
}

const ANSWER_TICKET =
  '# 01: Write the answer\n\n**What to build:** Write the single line `42` into the file `answer.txt` at the root of your worktree, then commit it with `git add answer.txt` and `git commit -m "Answer"`. Do nothing else: no other files, no exploring.\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] answer.txt says 42\n';

const refusedTicket = (command: string) =>
  `# 01: Write the answer\n\n**What to build:** Run the shell command \`${command}\` exactly once, from the root of your worktree. If it is refused or denied, do not retry it, do not work around it and do not do anything else: just stop. Do not write any files.\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] The command ran\n`;

/** A Project with one Story and one ready Ticket ("Write the answer"); its tests pass when answer.txt says 42. */
function contractProject(kiln: TestKiln, ticket: string, markerFile: string) {
  const repo = kiln.repo;
  writeRepoFile(repo, '.scratch/epics/contract.md', '---\ntitle: Contract\norder: 1\n---\n\nThe Agent contract.\n');
  writeRepoFile(repo, '.scratch/answer/story.md', '---\ntitle: Answer\nepic: contract\nstage: spec\nblocked-by: []\n---\n\nKnow the answer.\n');
  writeRepoFile(repo, '.scratch/answer/spec.md', '# Spec: Answer\n\nStatus: ready-for-agent\n');
  writeRepoFile(repo, '.scratch/answer/issues/01-write-the-answer.md', ticket);
  writeRepoFile(
    repo,
    '.kiln/settings.json',
    JSON.stringify({ testCommand: 'node check-answer.mjs', knownCommands: ['git add *', 'git commit *', 'git status*', 'git diff*', 'git log*'] }),
  );
  writeRepoFile(
    repo,
    'check-answer.mjs',
    "import { existsSync, readFileSync } from 'node:fs';\nconst answer = existsSync('answer.txt') ? readFileSync('answer.txt', 'utf8').trim() : '(no answer.txt)';\nif (answer !== '42') {\n  console.error(`expected 42, got ${answer}`);\n  process.exit(1);\n}\n",
  );
  // The refused command, were it to run, would leave a marker outside the worktree.
  writeRepoFile(repo, 'mark.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markerFile)}, 'ran');\n`);
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'Seed the contract Project');
}

async function startTicket(kiln: TestKiln) {
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Write the answer');
  assert.ok(ticket, 'the contract Ticket is on the board');
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session, 'the Session starts at once');
  return { ticket, session, events };
}

/** Registers the contract's tests for one Agent Widget. */
export function agentContract(subject: AgentContractSubject): void {
  const timeout = subject.timeoutMs ?? 60_000;
  const wait = { timeoutMs: timeout };
  const options = { skip: subject.skip || false, timeout };

  test(`${subject.name} keeps the Agent contract: it runs a Ticket to its Exit in its worktree, reports usage and writes a Digest`, options, async (t) => {
    const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-contract-knowledge') } });
    contractProject(kiln, ANSWER_TICKET, join(tempDir(t, 'kiln-contract-marker'), 'ran.txt'));
    await subject.install(t, kiln, { kind: 'answer' });
    const { ticket, session, events } = await startTicket(kiln);

    // Exit feedback may send it round again; the Exit has to be met in the end.
    for (let i = 0; ; i++) {
      const checked = await events.next<ExitCheckedEvent>('exit.checked', wait);
      if (checked.payload.exit.met) break;
      assert.ok(i < 2, `the Exit is met within three tries: ${JSON.stringify(checked.payload.exit)}`);
    }
    const moved = await events.next<ItemStageChangedEvent>('item.stage_changed', wait);
    assert.deepEqual([moved.payload.itemId, moved.payload.to], [ticket.id, 'review']);
    assert.equal(kiln.repo.git('show', `${session.branch}:answer.txt`).trim(), '42');

    const digest = (await events.next<DigestWrittenEvent>('digest.written', wait)).payload.digest;
    assert.equal(digest.sessionId, session.id);
    const records = await kiln.api<UsageRecord[]>('GET', `/api/usage/records?session=${encodeURIComponent(session.id)}`);
    assert.ok(records.length > 0, 'usage reaches the records');
    for (const r of records) {
      assert.ok(r.model, 'each record names its model');
      assert.ok(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0, 'each record counts tokens');
    }
  });

  test(`${subject.name} keeps the Agent contract: a command the Policy asks about becomes a Permission Ask, and Deny is honoured`, options, async (t) => {
    const kiln = await startTestKiln(t);
    const marker = join(tempDir(t, 'kiln-contract-marker'), 'ran.txt');
    const command = 'node mark.mjs';
    contractProject(kiln, refusedTicket(command), marker);
    await subject.install(t, kiln, { kind: 'refused_command', command });
    const { session, events } = await startTicket(kiln);

    const ask = (await events.next<AskRaisedEvent>('ask.raised', wait)).payload.ask;
    assert.equal(ask.type, 'permission');
    assert.equal(ask.permission?.action, 'other_commands');
    assert.match(ask.permission!.detail, /mark\.mjs/);
    assert.equal(ask.itemId, session.itemId);
    await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Deny' });
    const finished = await events.next<SessionAgentEvent<'finished'>>('session.finished', wait);
    assert.ok(finished.payload.reason, 'the Session finishes after the deny');
    assert.ok(!existsSync(marker), 'the denied command never ran');
  });
}
