import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  Digest,
  DigestWrittenEvent,
  Item,
  KilnEvent,
  Project,
  SessionInfo,
  SessionMessageEvent,
  StartResult,
  ThreadEntry,
  ThreadMessageResult,
} from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type EventStream, type FakeAgentStep, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

type ProgressEvent = KilnEvent<'session.progress', { sessionId: string; itemId: string; text?: string }>;

/** A Kiln whose Knowledge store is a throwaway folder the test can read. */
async function startKiln(t: Parameters<typeof startTestKiln>[0], env: Record<string, string> = {}) {
  const knowledge = tempDir(t, 'kiln-knowledge');
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: knowledge, ...env } });
  return { kiln, knowledge };
}

async function ticketIn(kiln: TestKiln): Promise<Item> {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const ticket = items.find((i) => i.title === 'Draw the columns');
  assert.ok(ticket);
  return ticket;
}

const itemPath = (item: Item, rest: string) => `/api/items/${encodeURIComponent(item.id)}/${rest}`;

const say = (kiln: TestKiln, item: Item, text: string) => kiln.api<ThreadMessageResult>('POST', itemPath(item, 'messages'), { text });

const start = async (kiln: TestKiln, item: Item): Promise<SessionInfo> =>
  (await kiln.api<StartResult>('POST', itemPath(item, 'start'))).session!;

/** Waits for the next progress event whose text matches. */
async function progress(events: EventStream, match: RegExp, timeoutMs = 15_000): Promise<ProgressEvent> {
  for (;;) {
    const event = await events.next<ProgressEvent>('session.progress', { timeoutMs });
    if (event.payload.text && match.test(event.payload.text)) return event;
  }
}

test('a Thread message reaches the Item\'s running Session and shows in its Thread as from the person', async (t) => {
  const { kiln } = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();
  const session = await start(kiln, ticket);

  const result = await say(kiln, ticket, 'Use three columns');

  assert.deepEqual(result, { delivery: 'running', sessionId: session.id });
  const heard = await progress(events, /^heard:/);
  assert.equal(heard.payload.text, 'heard: Use three columns');
  assert.equal(heard.payload.sessionId, session.id);
  const message = await events.next<SessionMessageEvent>('session.message');
  assert.deepEqual([message.payload.from, message.payload.text, message.payload.sessionId], ['person', 'Use three columns', session.id]);
});

test('a Thread message with no Session running starts a fresh one for the current Stage, which hears it', async (t) => {
  const { kiln } = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, { do: 'finish', reason: 'error' }] });
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();

  const result = await say(kiln, ticket, 'Start with the headers');

  assert.equal(result.delivery, 'fresh');
  const started = await events.next<KilnEvent<'session.started', { session: SessionInfo }>>('session.started');
  assert.equal(started.payload.session.id, result.sessionId);
  assert.equal(started.payload.session.stage, 'implementing');
  const heard = await progress(events, /^heard:/);
  assert.equal(heard.payload.text, 'heard: Start with the headers');
});

/** Lets the Project's tests pass, so a Session that commits meets the Implementing Exit. */
function passingTests(kiln: TestKiln) {
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add a test command');
}

const writeDigest = (decided: string[], changed: string[], open: string[]): FakeAgentStep => ({
  do: 'kiln_tool',
  name: 'write_digest',
  input: { decided, changed, open },
});

/** Every Markdown file under a folder, by path relative to it (forward slashes). */
function markdownFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(root, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
  }
  return files;
}

test('a Session that meets its Exit leaves the Digest it wrote with write_digest as markdown with frontmatter in the Knowledge store', async (t) => {
  const { kiln, knowledge } = await startKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'write', path: 'columns.txt', content: 'three\n' },
      { do: 'commit', message: 'Draw three columns' },
      writeDigest(['Three columns, not four'], ['Added columns.txt'], ['Column colours']),
    ],
  });
  const ticket = await ticketIn(kiln);
  passingTests(kiln);
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const written = await events.next<DigestWrittenEvent>('digest.written', { timeoutMs: 15_000 });
  await events.next('item.stage_changed', { timeoutMs: 15_000 });

  const digest = written.payload.digest;
  assert.deepEqual(
    [digest.kind, digest.sessionId, digest.stage, digest.writtenBy, digest.decided, digest.changed, digest.open],
    ['digest', session.id, 'implementing', 'session', ['Three columns, not four'], ['Added columns.txt'], ['Column colours']],
  );
  const files = markdownFiles(knowledge);
  assert.deepEqual(Object.keys(files), [digest.path]);
  const file = files[digest.path]!;
  assert.match(file, /^---\n/);
  const frontmatter = file.split('\n---\n')[0]!;
  assert.match(frontmatter, new RegExp(`^session: ${session.id}$`, 'm'));
  assert.match(frontmatter, /^stage: implementing$/m);
  assert.match(frontmatter, /^kind: digest$/m);
  assert.match(file, /## Decided\n\n- Three columns, not four\n/);
  assert.match(file, /## Changed\n\n- Added columns.txt\n/);
  assert.match(file, /## Open\n\n- Column colours\n/);
  assert.deepEqual(await kiln.api<Digest[]>('GET', itemPath(ticket, 'digests')), [digest]);
  // The Session wrote its Digest, so Kiln writes no second one when the Session ends.
  assert.equal(Object.keys(markdownFiles(knowledge)).length, 1);
});

test('a Session that ends without writing a Digest gets one from Kiln, so every Session end leaves one', async (t) => {
  const { kiln, knowledge } = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'progress', text: 'giving up' }, { do: 'finish', reason: 'error', message: 'crashed' }] });
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  const written = await events.next<DigestWrittenEvent>('digest.written', { timeoutMs: 15_000 });

  assert.equal(written.payload.digest.sessionId, session.id);
  assert.equal(written.payload.digest.writtenBy, 'kiln');
  assert.match(written.payload.digest.open.join('\n'), /ended \(error\) without writing a Digest/);
  assert.deepEqual(Object.keys(markdownFiles(knowledge)), [written.payload.digest.path]);
});

interface SeenStart {
  sessionId: string;
  prompt: string;
  seed: { artifacts?: { name: string; content: string }[]; digests?: string[] };
}

/** Waits for the fake Agent's `report_seed` progress and returns what its Session started from. */
async function seenStart(events: EventStream): Promise<SeenStart> {
  const event = await progress(events, /^seed: /);
  return JSON.parse(event.payload.text!.slice('seed: '.length)) as SeenStart;
}

const ended = async (events: EventStream) => {
  for (;;) {
    const event = await events.next<KilnEvent<'session.updated', { session: SessionInfo }>>('session.updated', { timeoutMs: 15_000 });
    if (!['running', 'paused', 'waiting'].includes(event.payload.session.state)) return event.payload.session;
  }
};

test('a fresh Session is seeded with the Item\'s artifacts and Digests, never with an earlier Session\'s transcript', async (t) => {
  const { kiln } = await startKiln(t);
  const agent = await kiln.installFakeAgent({
    script: [
      { do: 'progress', text: 'transcript-only: tried flexbox first' },
      writeDigest(['Use CSS grid'], ['Nothing yet'], ['Header height']),
      { do: 'finish', reason: 'error' },
    ],
  });
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();
  await start(kiln, ticket);
  await ended(events);

  agent.setScript([{ do: 'report_seed' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }]);
  const result = await say(kiln, ticket, 'Carry on');
  const seen = await seenStart(events);

  assert.equal(seen.sessionId, result.sessionId);
  assert.ok(seen.seed.artifacts?.some((a) => a.name === '.scratch/home-board/issues/01-draw-the-columns.md'));
  assert.equal(seen.seed.digests?.length, 1);
  assert.match(seen.seed.digests![0]!, /## Decided\n\n- Use CSS grid\n/);
  assert.match(seen.seed.digests![0]!, /## Open\n\n- Header height\n/);
  assert.doesNotMatch(JSON.stringify(seen), /transcript-only/);
  assert.match(seen.prompt, /write_digest/);
});

test('once an Item\'s Digests pile up they are rolled up into one, and the next Session is seeded with the rollup', async (t) => {
  const { kiln, knowledge } = await startKiln(t, { KILN_DIGEST_ROLLUP_AT: '2' });
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();
  const agent = await kiln.installFakeAgent({
    script: [writeDigest(['Grid layout'], ['Added grid.css'], ['Colours', 'Headers']), { do: 'finish', reason: 'error' }],
  });
  await start(kiln, ticket);
  await ended(events);
  agent.setScript([{ do: 'wait_for_message' }, writeDigest(['Blue headers'], ['Coloured the headers'], ['Colours']), { do: 'finish', reason: 'error' }]);
  await say(kiln, ticket, 'Colour the headers blue');
  await ended(events);

  const digests = await kiln.api<Digest[]>('GET', itemPath(ticket, 'digests'));
  assert.deepEqual(digests.map((d) => d.kind), ['digest', 'digest', 'rollup']);
  const rollup = digests[2]!;
  assert.deepEqual(rollup.covers, [digests[0]!.id, digests[1]!.id]);
  assert.deepEqual(rollup.decided, ['Grid layout', 'Blue headers']);
  assert.deepEqual(rollup.changed, ['Added grid.css', 'Coloured the headers']);
  assert.deepEqual(rollup.open, ['Colours'], 'the latest Digest says what is still open');
  assert.equal(Object.keys(markdownFiles(knowledge)).length, 3);

  agent.setScript([{ do: 'report_seed' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }]);
  await say(kiln, ticket, 'Next');
  const seen = await seenStart(events);
  assert.equal(seen.seed.digests?.length, 1);
  assert.match(seen.seed.digests![0]!, /^# Rollup/);
  assert.match(seen.seed.digests![0]!, /- Grid layout\n- Blue headers\n/);
});

test('a Thread message resumes the Item\'s ended Session while its Agent\'s cache is warm, and starts fresh from Digests once it has expired', async (t) => {
  const { kiln } = await startKiln(t);
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();
  const script: FakeAgentStep[] = [
    writeDigest(['Grid layout'], [], ['Colours']),
    { do: 'finish', reason: 'interrupted', message: 'out of turns' },
    { do: 'report_seed' },
    { do: 'finish', reason: 'interrupted' },
    { do: 'report_seed' },
  ];
  const cacheLifetimeMs = 2_000;
  await kiln.installFakeAgent({ script, cacheLifetimeMs });
  const first = await start(kiln, ticket);
  assert.equal((await ended(events)).state, 'interrupted');

  const warm = await say(kiln, ticket, 'Keep going');
  assert.deepEqual(warm, { delivery: 'resumed', sessionId: first.id });
  await progress(events, /^heard: Keep going$/);
  assert.equal((await seenStart(events)).sessionId, first.id);
  assert.equal((await ended(events)).id, first.id);

  await new Promise((done) => setTimeout(done, cacheLifetimeMs + 200));
  const cold = await say(kiln, ticket, 'Still there?');
  assert.equal(cold.delivery, 'fresh');
  assert.notEqual(cold.sessionId, first.id);
  const fresh = await seenStart(events);
  assert.equal(fresh.sessionId, cold.sessionId);
  assert.ok(fresh.seed.digests?.some((d) => d.includes('- Grid layout')), 'the fresh Session starts from the Digests');
});

test('an Item\'s Thread shows each of its Sessions in order, with their Digests, the person\'s messages and the Stage move', async (t) => {
  const { kiln } = await startKiln(t);
  const agent = await kiln.installFakeAgent({ script: [{ do: 'progress', text: 'first go' }, { do: 'finish', reason: 'error' }] });
  const ticket = await ticketIn(kiln);
  passingTests(kiln);
  const events = await kiln.events();
  const first = await start(kiln, ticket);
  await ended(events);

  agent.setScript([
    { do: 'wait_for_message' },
    { do: 'write', path: 'columns.txt', content: 'three\n' },
    { do: 'commit', message: 'Draw three columns' },
    writeDigest(['Three columns'], ['Added columns.txt'], []),
  ]);
  const second = await say(kiln, ticket, 'Try again');
  await events.next('item.stage_changed', { timeoutMs: 15_000 });

  const thread = await kiln.api<ThreadEntry[]>('GET', itemPath(ticket, 'thread'));
  const KEY = new Set(['session.started', 'session.message', 'digest.written', 'item.stage_changed']);
  const key = thread
    .filter((e) => KEY.has(e.type))
    .map((e) => {
      const p = e.payload as { sessionId?: string; from?: string; digest?: Digest; to?: string };
      const who = p.sessionId === first.id ? 'first' : p.sessionId === second.sessionId ? 'second' : String(p.sessionId);
      if (e.type === 'session.message') return `${who} message from ${p.from}`;
      if (e.type === 'digest.written') return `${who} digest by ${p.digest!.writtenBy}`;
      if (e.type === 'item.stage_changed') return `stage -> ${p.to}`;
      return `${who} started`;
    });
  assert.deepEqual(key, [
    'first started',
    'first digest by kiln',
    'second started',
    'second message from person',
    'second digest by session',
    'stage -> review',
  ]);
});

test('resuming after Stop all once the Agent\'s cache has expired ends the paused Session and starts a fresh one from Digests', async (t) => {
  const { kiln } = await startKiln(t);
  const ticket = await ticketIn(kiln);
  const events = await kiln.events();
  const cacheLifetimeMs = 1_000;
  const agent = await kiln.installFakeAgent({
    script: [writeDigest(['Grid layout'], [], []), { do: 'tool', name: 'think', times: 'forever', intervalMs: 50 }],
    cacheLifetimeMs,
  });
  const first = await start(kiln, ticket);
  await events.next<DigestWrittenEvent>('digest.written', { timeoutMs: 15_000 });
  await kiln.api('POST', '/api/scheduler/stop-all');
  await new Promise((done) => setTimeout(done, cacheLifetimeMs + 200));

  agent.setScript([{ do: 'report_seed' }, { do: 'wait_for_message' }]);
  await kiln.api('POST', '/api/scheduler/resume');
  const seen = await seenStart(events);
  assert.notEqual(seen.sessionId, first.id, 'a fresh Session, not the paused one');
  assert.ok(seen.seed.digests?.some((d) => d.includes('- Grid layout')));
  assert.equal((await kiln.api<SessionInfo>('GET', `/api/sessions/${first.id}`)).state, 'stopped');
});

test('a Thread message is refused when the Item\'s Stage runs no Session, and when it is empty', async (t) => {
  const { kiln } = await startKiln(t);
  await kiln.installFakeAgent();
  await ticketIn(kiln);
  // The Epic's Roadmap Stage runs no Session (it only waits for its Stories).
  const epic = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Board as home')!;
  const ticket = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Draw the columns')!;

  const noStage = await kiln.request<{ error: string }>('POST', itemPath(epic, 'messages'), { text: 'hello' });
  assert.equal(noStage.status, 409);
  assert.match(noStage.body.error, /runs no Session/);
  const empty = await kiln.request('POST', itemPath(ticket, 'messages'), { text: '  ' });
  assert.equal(empty.status, 400);
  assert.deepEqual(await kiln.api('GET', '/api/sessions'), []);
});
