// Variants and the local server (local-first Ticket 04): Kiln writes a variant's own entry in
// llama-swap's config (hand-written entries and comments survive), reloads, smoke-tests it, and
// shows entries already in the config as variants that can be enabled. Every test talks to a fake
// llama-swap, never a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalServerSettings, Variant, VariantList } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { startFakeLocalServer, type FakeLocalServer } from '@kiln/testing/fake-local-server';

/** A config a person wrote: comments, odd spacing, a macro, a multi-line command, a group. */
const SAMPLE = `# llama-swap config, kept by hand
healthCheckTimeout: 500   # seconds
macros:
  "server": llama-server --port \${PORT}

models:
  # The everyday model
  "coder-hand":
    cmd: |
      /opt/llama/llama-server --port \${PORT}
      -m /models/Coder-30B-Q4_K_M.gguf -c 32768 -ngl 99
      --cache-type-k q8_0 --cache-type-v q8_0 --jinja
    ttl: 300   # five minutes

  small:
    cmd: \${server} -m "/models/small model-Q8_0.gguf" -c 8192
# a trailing comment

groups:
  everyday:
    swap: true
    members: ["coder-hand", small]
`;

/** A Kiln pointed at a fake llama-swap serving SAMPLE, and a GGUF file on disk. */
async function setup(t: Cleanup, options: { login?: 'local' | 'tailscale' } = {}) {
  const kiln = await startTestKiln(t, options);
  const fake = await startFakeLocalServer(t, { config: SAMPLE, loadMs: 60 });
  await kiln.api<LocalServerSettings>('PUT', '/api/local-server', { configPath: fake.configPath, url: fake.url, reloadTimeoutSeconds: 5 });
  const models = tempDir(t, 'kiln-models');
  const gguf = (name: string) => {
    const path = join(models, name);
    writeFileSync(path, Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(1024)]));
    return path;
  };
  return { kiln, fake, gguf };
}

const SETTINGS = { contextSize: 65536, gpuLayers: 999, kvCacheType: 'q8_0', threads: 8, extraFlags: ['--jinja'] };

/** The entry Kiln writes for a file and settings, as lines of the config. */
const entryFor = (modelId: string, path: string, s: { contextSize: number; gpuLayers: number; kvCacheType: string; threads: number }) =>
  `  ${modelId}:\n    cmd: |\n      llama-server --port \${PORT} -m ${path.replace(/\\/g, '/')} -c ${s.contextSize} -ngl ${s.gpuLayers}` +
  ` --cache-type-k ${s.kvCacheType} --cache-type-v ${s.kvCacheType} -t ${s.threads} --jinja\n`;

/** SAMPLE with Kiln's entry added after the last hand-written one. */
const withEntry = (entry: string) => SAMPLE.replace('# a trailing comment', `${entry}# a trailing comment`);

const add = (kiln: TestKiln, path: string, extra: Record<string, unknown> = {}) =>
  kiln.request<Variant & { error?: string }>('POST', '/api/variants', { name: 'Qwen coder Q4', file: { path }, settings: SETTINGS, ...extra });

const messagesTo = (fake: FakeLocalServer, model: string) =>
  fake.requests().filter((r) => r.path === '/v1/messages' && (r.body as { model?: string }).model === model);

test('the local server is a Setting with no default path; only an Admin changes it, and bad values are refused', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });

  const defaults = await kiln.api<LocalServerSettings>('GET', '/api/local-server');
  assert.deepEqual(defaults, { kind: 'llama-swap', serverCommand: 'llama-server', smokeTimeoutSeconds: 300, reloadTimeoutSeconds: 30 });
  const unconfigured = await kiln.api<VariantList>('GET', '/api/variants');
  assert.deepEqual(unconfigured, { variants: [], server: { configured: false, reachable: false } });
  const early = await kiln.request<{ error: string }>('POST', '/api/variants', { name: 'x', file: { path: '/none.gguf' }, settings: SETTINGS });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /config path and URL/);

  assert.equal((await kiln.as('mo').request('PUT', '/api/local-server', { url: 'http://127.0.0.1:9' })).status, 403);
  assert.equal((await kiln.as('mo').request('POST', '/api/variants', { name: 'x' })).status, 403);
  assert.equal((await kiln.request('PUT', '/api/local-server', { configPath: 'relative/config.yaml' })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/local-server', { url: 'not a url' })).status, 400);
  assert.equal((await kiln.request('PUT', '/api/local-server', { colour: 'red' })).status, 400);

  const fake = await startFakeLocalServer(t, { config: SAMPLE });
  const set = await kiln.api<LocalServerSettings>('PUT', '/api/local-server', { configPath: fake.configPath, url: fake.url });
  assert.equal(set.configPath, fake.configPath);
  assert.equal(set.url, fake.url);
  assert.deepEqual(await kiln.as('mo').api<LocalServerSettings>('GET', '/api/local-server'), set);
  const cleared = await kiln.api<LocalServerSettings>('PUT', '/api/local-server', { url: null });
  assert.equal(cleared.url, undefined);
});

test('adding a variant writes only its own entry, waits for the server, and smoke-tests it with a tool call', async (t) => {
  const { kiln, fake, gguf } = await setup(t);
  const path = gguf('Qwen-Coder-Q4_K_M.gguf');

  const added = await add(kiln, path, { serverModelId: 'qwen-coder-q4' });
  assert.equal(added.status, 201, added.body.error);
  const variant = added.body;
  assert.equal(variant.id, 'qwen-coder-q4');
  assert.equal(variant.serverModelId, 'qwen-coder-q4');
  assert.deepEqual(variant.file, { path, sizeBytes: 1028, quant: 'Q4_K_M' });
  assert.deepEqual(variant.settings, SETTINGS);
  assert.equal(variant.state, 'enabled');
  assert.equal(variant.origin, 'kiln');
  assert.equal(variant.recorded, true);
  const smoke = variant.lastSmokeTest!;
  assert.equal(smoke.passed, true);
  assert.ok(smoke.loadMs! >= 60, `load time ${smoke.loadMs}`);
  assert.ok(smoke.tokensPerSecond! > 0, `tokens per second ${smoke.tokensPerSecond}`);

  // Every hand-written line is where it was, byte for byte; the new entry is the only change.
  assert.equal(fake.config(), withEntry(entryFor('qwen-coder-q4', path, SETTINGS)));

  // The smoke test: a one-token load, then one Messages request offering a tool.
  const sent = messagesTo(fake, 'qwen-coder-q4');
  assert.equal(sent.length, 2);
  assert.equal((sent[0]!.body as { max_tokens: number }).max_tokens, 1);
  const tools = (sent[1]!.body as { tools: { name: string }[] }).tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['read_file']);
  assert.ok(fake.requests().some((r) => r.path === '/api/models/unload/qwen-coder-q4'));

  const list = await kiln.api<VariantList>('GET', '/api/variants');
  assert.deepEqual(list.server, { configured: true, reachable: true });
  assert.deepEqual(list.variants.find((v) => v.id === 'qwen-coder-q4'), variant);

  // Without a model id, one is made from the file name. A name already in the config is refused.
  assert.equal((await add(kiln, path, { serverModelId: 'small' })).status, 409);
  const plain = await add(kiln, gguf('Other-IQ4_XS.gguf'));
  assert.equal(plain.body.serverModelId, 'other-iq4_xs');
  assert.equal(plain.body.file!.quant, 'IQ4_XS');

  // Not a GGUF file, a missing file, a missing setting and a flag Kiln writes itself are refused.
  const notGguf = join(tempDir(t, 'kiln-not-gguf'), 'notes.gguf');
  writeFileSync(notGguf, 'hello');
  assert.equal((await add(kiln, notGguf)).status, 400);
  assert.equal((await add(kiln, join(tempDir(t, 'kiln-empty'), 'none.gguf'))).status, 400);
  const noCtx = await kiln.request('POST', '/api/variants', { name: 'x', file: { path }, settings: { gpuLayers: 1, kvCacheType: 'f16' } });
  assert.equal(noCtx.status, 400);
  const ownFlag = await kiln.request('POST', '/api/variants', { name: 'x', file: { path }, settings: { ...SETTINGS, extraFlags: ['-c', '4096'] } });
  assert.equal(ownFlag.status, 400);
});

test('editing a variant changes only its own entry; removing it restores the hand-written config and keeps its record', async (t) => {
  const { kiln, fake, gguf } = await setup(t);
  const path = gguf('Qwen-Coder-Q4_K_M.gguf');
  const variant = (await add(kiln, path, { serverModelId: 'qwen-coder-q4' })).body;

  // The person adds a key of their own to Kiln's entry; Kiln's edit keeps it.
  fake.writeConfig(fake.config().replace('--jinja\n# a trailing', '--jinja\n    ttl: 60\n# a trailing'));
  const edited = await kiln.api<Variant>('PATCH', `/api/variants/${variant.id}`, { settings: { contextSize: 32768 } });
  assert.equal(edited.settings.contextSize, 32768);
  assert.equal(edited.settings.kvCacheType, 'q8_0');
  assert.equal(edited.state, 'enabled');
  assert.notEqual(edited.lastSmokeTest!.at, undefined);
  assert.equal(fake.config(), withEntry(`${entryFor('qwen-coder-q4', path, { ...SETTINGS, contextSize: 32768 })}    ttl: 60\n`));

  // A new name alone doesn't touch the config or run another smoke test.
  const before = fake.requests().length;
  const renamed = await kiln.api<Variant>('PATCH', `/api/variants/${variant.id}`, { name: 'Qwen coder, 32K' });
  assert.equal(renamed.name, 'Qwen coder, 32K');
  assert.equal(fake.requests().length, before);

  fake.writeConfig(fake.config().replace('    ttl: 60\n', ''));
  const removed = await kiln.api<Variant>('DELETE', `/api/variants/${variant.id}`);
  assert.equal(removed.state, 'removed');
  assert.ok(removed.removedAt);
  assert.deepEqual(removed.lastSmokeTest, edited.lastSmokeTest);
  assert.equal(fake.config(), SAMPLE);

  const list = await kiln.api<VariantList>('GET', '/api/variants');
  assert.deepEqual(list.variants.find((v) => v.id === variant.id), removed);
  assert.equal((await kiln.request('POST', `/api/variants/${variant.id}/enable`)).status, 409);
  // The same file again is a new variant; the removed one keeps its id and results.
  const again = await add(kiln, path, { serverModelId: 'qwen-coder-q4' });
  assert.equal(again.status, 201);
  assert.equal(again.body.id, 'qwen-coder-q4-2');
});

test('entries the server already serves appear as variants that can be enabled, disabled and removed', async (t) => {
  const { kiln, fake } = await setup(t);

  const { variants } = await kiln.api<VariantList>('GET', '/api/variants');
  assert.deepEqual(variants, [
    {
      id: 'coder-hand',
      name: 'coder-hand',
      serverModelId: 'coder-hand',
      file: { path: '/models/Coder-30B-Q4_K_M.gguf', quant: 'Q4_K_M' },
      settings: { contextSize: 32768, gpuLayers: 99, kvCacheType: 'q8_0', extraFlags: ['--jinja'] },
      serverCommand: '/opt/llama/llama-server',
      state: 'disabled',
      disabledReason: "Found in the local server's config; enable it to use it",
      origin: 'server',
      recorded: false,
    },
    {
      id: 'small',
      name: 'small',
      serverModelId: 'small',
      file: { path: '/models/small model-Q8_0.gguf', quant: 'Q8_0' },
      settings: { contextSize: 8192, extraFlags: [] },
      serverCommand: '${server}',
      state: 'disabled',
      disabledReason: "Found in the local server's config; enable it to use it",
      origin: 'server',
      recorded: false,
    },
  ]);

  const enabled = await kiln.api<Variant>('POST', '/api/variants/coder-hand/enable');
  assert.equal(enabled.state, 'enabled');
  assert.equal(enabled.recorded, true);
  assert.equal(enabled.disabledReason, undefined);
  assert.equal(fake.config(), SAMPLE, 'enabling a hand-written entry leaves the config alone');
  const listed = (await kiln.api<VariantList>('GET', '/api/variants')).variants;
  assert.deepEqual(listed.map((v) => [v.id, v.state, v.recorded]), [['coder-hand', 'enabled', true], ['small', 'disabled', false]]);

  const disabled = await kiln.api<Variant>('POST', '/api/variants/coder-hand/disable', { reason: 'Too slow at 128K' });
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.disabledReason, 'Too slow at 128K');

  // Removing a hand-written entry takes it out of the config and out of its group, and nothing else.
  const removed = await kiln.api<Variant>('DELETE', '/api/variants/small');
  assert.equal(removed.state, 'removed');
  assert.equal(removed.recorded, true);
  const expected = SAMPLE.replace(`  small:\n    cmd: \${server} -m "/models/small model-Q8_0.gguf" -c 8192\n`, '').replace('["coder-hand", small]', '["coder-hand"]');
  assert.equal(fake.config(), expected);
  assert.deepEqual(fake.models(), ['coder-hand']);

  // Editing a hand-written entry rewrites its command alone: its own server path and its ttl stay.
  const edited = await kiln.api<Variant>('PATCH', '/api/variants/coder-hand', { settings: { contextSize: 65536 } });
  assert.equal(edited.state, 'enabled');
  const handCmd =
    '      /opt/llama/llama-server --port ${PORT}\n      -m /models/Coder-30B-Q4_K_M.gguf -c 32768 -ngl 99\n      --cache-type-k q8_0 --cache-type-v q8_0 --jinja\n';
  const newCmd = '      /opt/llama/llama-server --port ${PORT} -m /models/Coder-30B-Q4_K_M.gguf -c 65536 -ngl 99 --cache-type-k q8_0 --cache-type-v q8_0 --jinja\n';
  assert.equal(fake.config(), expected.replace(handCmd, newCmd));

  assert.equal((await kiln.request('POST', '/api/variants/nothing-here/enable')).status, 404);
});

test('a failed smoke test leaves the variant disabled with the reason; a passing one enables it', async (t) => {
  const { kiln, fake, gguf } = await setup(t);
  fake.reply('chatty-q4', { kind: 'text', text: 'Sure, here is README.md...' });

  const added = await add(kiln, gguf('Chatty-Q4_K_M.gguf'), { serverModelId: 'chatty-q4' });
  assert.equal(added.status, 201);
  const variant = added.body;
  assert.equal(variant.state, 'disabled');
  assert.match(variant.disabledReason!, /^Smoke test failed: It answered without calling the tool/);
  assert.equal(variant.lastSmokeTest!.passed, false);
  assert.ok(variant.lastSmokeTest!.loadMs! >= 60);
  assert.ok(variant.lastSmokeTest!.tokensPerSecond! > 0);

  fake.reply('chatty-q4', { kind: 'error', status: 500, message: 'failed to allocate KV cache' });
  const oom = await kiln.api<Variant>('POST', `/api/variants/${variant.id}/smoke-test`);
  assert.equal(oom.state, 'disabled');
  assert.match(oom.disabledReason!, /didn't load \(HTTP 500\): failed to allocate KV cache/);
  assert.equal(oom.lastSmokeTest!.loadMs, undefined);

  fake.reply('chatty-q4', { kind: 'tool' });
  const fixed = await kiln.api<Variant>('POST', `/api/variants/${variant.id}/smoke-test`);
  assert.equal(fixed.state, 'enabled');
  assert.equal(fixed.lastSmokeTest!.passed, true);

  // A server that doesn't answer fails the smoke test too, with the reason.
  await kiln.api('PUT', '/api/local-server', { url: 'http://127.0.0.1:9' });
  const down = await kiln.api<Variant>('POST', `/api/variants/${variant.id}/smoke-test`);
  assert.equal(down.state, 'disabled');
  assert.match(down.disabledReason!, /local server didn't answer/);
  const list = await kiln.api<VariantList>('GET', '/api/variants');
  assert.equal(list.server.reachable, false);
  assert.match(list.server.error!, /didn't answer/);
});
