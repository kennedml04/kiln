// Role modes, results and the variant picker through a real core (local-first Ticket 07).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Item, LocalRouting, Project, SessionInfo, StartResult, ThreadEntry, Variant, VariantResult } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { startFakeLocalServer } from '@kiln/testing/fake-local-server';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const thread = (kiln: TestKiln, item: Item) => kiln.api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(item.id)}/thread`);
const messages = async (kiln: TestKiln, item: Item) =>
  (await thread(kiln, item)).filter((e) => e.type === 'session.message').map((e) => String(e.payload.text));

async function register(kiln: TestKiln) {
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  return { project, ticket: items.find((i) => i.title === 'Draw the columns')! };
}

/** An enabled variant, added through a fake llama-swap. */
async function addVariant(t: Cleanup, kiln: TestKiln, name = 'Coder Q4') {
  const fake = await startFakeLocalServer(t, { config: 'models: {}\n', loadMs: 20 });
  await kiln.api('PUT', '/api/local-server', { configPath: fake.configPath, url: fake.url, reloadTimeoutSeconds: 5 });
  const path = join(tempDir(t, 'kiln-models'), `${name.replace(/\W+/g, '-')}.gguf`);
  writeFileSync(path, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(1024)]));
  const variant = await kiln.api<Variant>('POST', '/api/variants', {
    name,
    file: { path },
    settings: { contextSize: 8192, gpuLayers: 99, kvCacheType: 'f16', extraFlags: [] },
  });
  assert.equal(variant.state, 'enabled', variant.disabledReason);
  return variant;
}

const start = async (kiln: TestKiln, item: Item): Promise<SessionInfo> =>
  (await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`)).session!;

test('the Workflow validator accepts the role modes and rejects unknown ones', async (t) => {
  const kiln = await startTestKiln(t);
  const workflow = (mode: unknown) => ({
    name: 'Modes',
    kinds: [{ id: 'ticket', name: 'Ticket', stages: [
      { id: 'implementing', name: 'Implementing', role: 'implementer', agent: 'claude-code', model: 'm', mode },
      { id: 'done', name: 'Done' },
    ] }],
  });
  const readErrors = async () => {
    const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path }).catch(() => kiln.api<Project[]>('GET', '/api/projects').then((all) => all[0]!));
    return (await kiln.api<Project>('GET', `/api/projects/${project.id}`)).errors;
  };
  const errorsFor = async (mode: unknown) => {
    writeRepoFile(kiln.repo, '.kiln/workflow.json', JSON.stringify(workflow(mode)));
    kiln.repo.git('add', '.');
    kiln.repo.git('commit', '-q', '-m', 'Kiln workflow');
    return readErrors();
  };
  for (const mode of ['local-first', 'cloud-only', 'local-only']) assert.deepEqual(await errorsFor(mode), [], mode);
  // The Project re-reads the committed Workflow on its own schedule: ask until it has.
  let errors = await errorsFor('sometimes');
  for (let i = 0; i < 20 && !errors.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    errors = await readErrors();
  }
  assert.equal(errors[0]?.at, 'kinds[0].stages[0].mode');
  assert.match(errors[0]!.message, /local-first, cloud-only, local-only/);
});

test("a local-first Ticket's Thread names the variant and the picker's reason, and its result is recorded", async (t) => {
  const kiln = await startTestKiln(t);
  const variant = await addVariant(t, kiln);
  await kiln.installFakeAgent({ script: [{ do: 'write', path: 'feature.txt', content: 'columns\n' }, { do: 'commit', message: 'Draw the columns' }] });
  writeRepoFile(kiln.repo, '.kiln/settings.json', `${JSON.stringify({ testCommand: 'node -e "process.exit(0)"' })}
`);
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Kiln settings');
  const { ticket } = await register(kiln);
  const events = await kiln.events();

  const session = await start(kiln, ticket);
  assert.equal(session.model, variant.serverModelId, 'the Session runs on the variant');
  await events.next('session.finished', { timeoutMs: 15_000 });

  const said = await messages(kiln, ticket);
  assert.ok(
    said.some((m) => m.includes('Coder Q4') && m.includes('new variant, 0 of 5 results')),
    said.join('\n'),
  );
  // The result is recorded when the Stage's Exit is met.
  const deadline = Date.now() + 10_000;
  let results: VariantResult[] = [];
  while (!results.length && Date.now() < deadline) {
    results = await kiln.api<VariantResult[]>('GET', `/api/variant-results?variantId=${variant.id}`);
    if (!results.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(results.length, 1);
  assert.deepEqual([results[0]!.role, results[0]!.size, results[0]!.passed, results[0]!.itemId], ['implementer', 'medium', true, ticket.id]);
  assert.ok(results[0]!.wallMs > 0);
  assert.equal(results[0]!.files, 1);
});

test('a local-first role with no enabled variant runs on cloud and says so', async (t) => {
  const kiln = await startTestKiln(t);
  const variant = await addVariant(t, kiln);
  await kiln.api('POST', `/api/variants/${variant.id}/disable`, { reason: 'for the test' });
  await kiln.installFakeAgent({ script: [] });
  const { ticket } = await register(kiln);
  const session = await start(kiln, ticket);
  assert.ok(session.model);
  const said = await messages(kiln, ticket);
  assert.ok(said.some((m) => /no enabled local variant: running on cloud/.test(m)), said.join('\n'));
});

test('a local-only install or Project never starts a cloud Session', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [] });
  const { project, ticket } = await register(kiln);
  const routing = await kiln.api<LocalRouting>('PUT', '/api/local-routing', { localOnly: true });
  assert.equal(routing.localOnly, true);
  await assert.rejects(start(kiln, ticket), /local only/);
  assert.deepEqual(await kiln.api<SessionInfo[]>('GET', `/api/items/${encodeURIComponent(ticket.id)}/sessions`).catch(() => []), []);

  // The same through the Project's own switch in .kiln/settings.json.
  await kiln.api('PUT', '/api/local-routing', { localOnly: false });
  writeRepoFile(kiln.repo, '.kiln/settings.json', `${JSON.stringify({ localOnly: true })}\n`);
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Kiln settings');
  await kiln.api('GET', `/api/projects/${project.id}`);
  await assert.rejects(start(kiln, ticket), /local only/);

  // With a variant it starts, locally.
  await addVariant(t, kiln);
  const session = await start(kiln, ticket);
  assert.ok(session.model && session.model !== 'claude-test-model');
});

test('a pin on a role overrides the picker', async (t) => {
  const kiln = await startTestKiln(t);
  const first = await addVariant(t, kiln, 'First one');
  await kiln.installFakeAgent({ script: [] });
  const { ticket } = await register(kiln);
  const pins = await kiln.api<LocalRouting>('PUT', '/api/local-routing', { pin: { role: 'implementer', variantId: first.id } });
  assert.equal(pins.pins['role:implementer'], first.id);
  await start(kiln, ticket);
  assert.ok((await messages(kiln, ticket)).some((m) => m.includes('is pinned to the implementer role')));
});
