// Add a model (local-first Ticket 06), through the core API: a GGUF file's facts and recommended
// settings, a Hugging Face repo's GGUF files, and a download that resumes. Hugging Face is a fake
// on a local port; no test reaches huggingface.co.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HuggingFaceFiles, LocalServerSettings, ModelDownload, ModelInspection, PanelBlock, PanelContent } from '@kiln/widget-sdk';
import { createWidgetSource, driveTestWidget, startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { startFakeHuggingFace } from '@kiln/testing/fake-hugging-face';
import { testGguf } from '@kiln/testing/test-gguf';

const REPO = 'test-org/Tiny-Coder-GGUF';

async function withHuggingFace(t: Cleanup, options: { chunkDelayMs?: number; env?: Record<string, string> } = {}) {
  const hf = await startFakeHuggingFace(t, { chunkBytes: 8 * 1024, ...(options.chunkDelayMs ? { chunkDelayMs: options.chunkDelayMs } : {}) });
  const q4 = testGguf({ name: 'Tiny Coder', weightBytes: 200 * 1024 });
  const q8 = testGguf({ name: 'Tiny Coder', weightBytes: 400 * 1024 });
  hf.addRepo(REPO, [
    { path: 'Tiny-Coder-Q4_K_M.gguf', bytes: q4 },
    { path: 'Q8_0/Tiny-Coder-Q8_0.gguf', bytes: q8 },
  ]);
  const kiln = await startTestKiln(t, { env: { KILN_HUGGINGFACE_URL: hf.url, ...options.env } });
  const models = tempDir(t, 'kiln-models');
  return { hf, kiln, models, q4, q8 };
}

/** A test Widget installed as the GPU monitor, whose panel the test publishes by hand. */
async function fakeGpuMonitor(t: Cleanup, kiln: TestKiln) {
  const source = createWidgetSource(t, {
    manifest: { id: 'gpu-monitor', name: 'GPU monitor', provides: { panels: [{ id: 'gpus', title: 'GPUs', placement: 'home' }] } },
  });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', '/api/widgets/gpu-monitor/approve');
  await events.next('widget.ready');
  events.close();
  const widget = driveTestWidget(kiln, 'gpu-monitor');
  return {
    publish: async (content: PanelContent) => assert.equal((await widget.call('PUT', '/api/widget/panels/gpus', content)).status, 200),
  };
}

const gpuCard = (index: number, vramText: string, data?: Record<string, number | null>): PanelBlock => ({
  kind: 'card',
  id: `gpu-${index}`,
  title: `GPU ${index}: Test GPU ${index}`,
  ...(data ? { data } : {}),
  blocks: [{ kind: 'stat', id: `gpu-${index}-vram`, label: 'VRAM', value: vramText, unit: 'GB' }],
});

/** Polls a download until it stops running. */
async function settled(kiln: TestKiln, id: string): Promise<ModelDownload> {
  for (let i = 0; i < 200; i++) {
    const d = await kiln.api<ModelDownload>('GET', `/api/local-models/downloads/${id}`);
    if (d.state !== 'running') return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the download never finished');
}

test('inspecting a GGUF file gives its shape and recommended settings, each with a reason; with no GPU monitor every layer stays on the CPU', async (t) => {
  const kiln = await startTestKiln(t);
  const path = join(tempDir(t, 'kiln-gguf'), 'Tiny-Test-Q4_K_M.gguf');
  writeFileSync(path, testGguf());

  const info = await kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path });
  assert.deepEqual(info.file, { path, sizeBytes: statSync(path).size, quant: 'Q4_K_M' });
  assert.deepEqual(info.model, { architecture: 'llama', name: 'Tiny Test', layerCount: 32, kvHeadCount: 8, keyLength: 128, valueLength: 128, trainingContext: 131072 });
  assert.deepEqual(info.gpu, { source: null, memoryUsedMiB: null, memoryTotalMiB: null });
  const r = info.recommended;
  assert.deepEqual([r.contextSize, r.gpuLayers, r.kvCacheType, r.offloaded], [16384, 0, 'f16', true]);
  assert.match(r.reasons.contextSize, /GPU monitor reported no VRAM figures/);
  assert.match(r.reasons.gpuLayers, /every layer stays on the CPU/);
  // 32 layers x 8 KV heads x (128 + 128) x 2 bytes = 128 KB a token; 2 GB at 16K.
  assert.equal(r.figures.kvBytesPerToken, 131072);
  assert.equal(r.reasons.kvCacheType, "f16 takes 128 KB of cache a token, 2 GB at 16K; it is llama-server's default, and q8_0 would take about half");
  assert.match(r.reasons.threads, /^half of this machine's \d+ logical CPUs$/);
  assert.equal(info.suggestedName, 'Tiny Test Q4_K_M');
  assert.equal(info.suggestedServerModelId, 'tiny-test-q4_k_m');
  assert.ok(info.kvCacheTypes.includes('q8_0'));

  // Another KV cache type is sized for on request.
  const q8 = await kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path, kvCacheType: 'q8_0' });
  assert.equal(q8.recommended.kvCacheType, 'q8_0');
  assert.equal(q8.recommended.figures.kvBytesPerToken, 131072 * (34 / 32) / 2);

  // Not a GGUF file, no file, a relative path, an unknown cache type: each refused, saying why.
  const notGguf = join(tempDir(t, 'kiln-gguf'), 'notes.gguf');
  writeFileSync(notGguf, 'hello world');
  const refusals = [
    [{ path: notGguf }, /is not a GGUF file/],
    [{ path: join(tempDir(t, 'kiln-gguf'), 'none.gguf') }, /There is no file at/],
    [{ path: 'models/x.gguf' }, /must be a full path/],
    [{ path, kvCacheType: 'q3' }, /"kvCacheType" must be one of/],
  ] as const;
  for (const [body, message] of refusals) {
    const res = await kiln.request<{ error: string }>('POST', '/api/local-models/inspect', body);
    assert.equal(res.status, 400);
    assert.match(res.body.error, message);
  }
});

test("inspect sizes for the GPU monitor's numeric VRAM reading, whatever its display text says", async (t) => {
  const kiln = await startTestKiln(t);
  const gpu = await fakeGpuMonitor(t, kiln);
  const path = join(tempDir(t, 'kiln-gguf'), 'Tiny-Test-Q4_K_M.gguf');
  writeFileSync(path, testGguf());
  const inspect = () => kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path });
  const gpu0 = { source: 'gpu-monitor', name: 'GPU 0: Test GPU 0', memoryUsedMiB: 12288, memoryTotalMiB: 24576 };

  // Display text in a wording no parser would read, and the numbers beside it.
  await gpu.publish({
    blocks: [
      gpuCard(0, '12 GB used of 24 GB', { memoryUsedMiB: 12288, memoryTotalMiB: 24576 }),
      gpuCard(1, 'a third full', { memoryUsedMiB: 4096, memoryTotalMiB: 12288 }),
    ],
  });
  const info = await inspect();
  assert.deepEqual(info.gpu, gpu0, 'the GPU with the most free VRAM');
  assert.deepEqual([info.recommended.gpuLayers, info.recommended.figures.freeBytes], [33, 12 * 1024 ** 3]);

  // The wording changes again: the reading doesn't.
  await gpu.publish({ blocks: [gpuCard(0, 'half', { memoryUsedMiB: 12288, memoryTotalMiB: 24576 })] });
  assert.deepEqual((await inspect()).gpu, gpu0);

  // Display text alone, even in the old "used / total" form, is no reading; nor are unknown numbers.
  for (const card of [gpuCard(0, '12.0 / 24.0'), gpuCard(0, 'n/a / 24.0', { memoryUsedMiB: null, memoryTotalMiB: 24576 })]) {
    await gpu.publish({ blocks: [card] });
    const none = await inspect();
    assert.deepEqual(none.gpu, { source: null, memoryUsedMiB: null, memoryTotalMiB: null });
    assert.equal(none.recommended.gpuLayers, 0);
  }
});

test('Add a model routes are Admin-only', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const mo = kiln.as('mo');
  assert.equal((await mo.request('POST', '/api/local-models/inspect', { path: '/x.gguf' })).status, 403);
  assert.equal((await mo.request('GET', `/api/local-models/huggingface?repo=${REPO}`)).status, 403);
  assert.equal((await mo.request('POST', '/api/local-models/downloads', { repo: REPO, file: 'x.gguf' })).status, 403);
  assert.equal((await mo.request('GET', '/api/local-models/downloads')).status, 403);
  assert.equal((await mo.request('PUT', '/api/local-server', { modelsFolder: '/models' })).status, 403);
});

test("a Hugging Face repo's GGUF files are listed with their sizes; an unknown repo says so", async (t) => {
  const { kiln, q4, q8 } = await withHuggingFace(t);
  const listed = await kiln.api<HuggingFaceFiles>('GET', `/api/local-models/huggingface?repo=${REPO}`);
  assert.deepEqual(listed, {
    repo: REPO,
    files: [
      { path: 'Q8_0/Tiny-Coder-Q8_0.gguf', sizeBytes: q8.length, quant: 'Q8_0' },
      { path: 'Tiny-Coder-Q4_K_M.gguf', sizeBytes: q4.length, quant: 'Q4_K_M' },
    ],
  });
  const missing = await kiln.request<{ error: string }>('GET', '/api/local-models/huggingface?repo=test-org/nothing');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no public repo test-org\/nothing/);
  const badName = await kiln.request<{ error: string }>('GET', '/api/local-models/huggingface?repo=just-a-name');
  assert.equal(badName.status, 400);
});

test('with no fake named, the core reaches no Hugging Face at all', async (t) => {
  const kiln = await startTestKiln(t);
  const res = await kiln.request<{ error: string }>('GET', `/api/local-models/huggingface?repo=${REPO}`);
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Couldn't reach Hugging Face at http:\/\/127\.0\.0\.1:9/);
});

test('a download goes to the models folder Setting, and an interrupted one resumes with a Range request', async (t) => {
  const { hf, kiln, models, q8 } = await withHuggingFace(t);
  const file = 'Q8_0/Tiny-Coder-Q8_0.gguf';

  // No models folder yet: nothing downloads.
  const early = await kiln.request<{ error: string }>('POST', '/api/local-models/downloads', { repo: REPO, file });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /models folder/);
  const settings = await kiln.api<LocalServerSettings>('PUT', '/api/local-server', { modelsFolder: models });
  assert.equal(settings.modelsFolder, models);
  assert.equal(hf.requests().filter((r) => r.path.includes('/resolve/')).length, 0);

  // The first try is cut off part-way.
  hf.cutNext(REPO, file, 100 * 1024);
  const first = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: REPO, file });
  assert.equal(first.path, join(models, 'Tiny-Coder-Q8_0.gguf'));
  assert.equal(first.totalBytes, q8.length);
  const failed = await settled(kiln, first.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.error!, /The download stopped at .* Start it again to resume from there\./);
  const partial = statSync(`${failed.path}.part`).size;
  assert.ok(partial > 0 && partial < q8.length, `the part file holds ${partial} bytes`);
  assert.equal(failed.receivedBytes, partial);
  assert.equal(existsSync(failed.path), false);

  // Starting it again asks only for the rest, and the finished file is byte for byte the original.
  const again = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: REPO, file });
  const done = await settled(kiln, again.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.resumedFromBytes, partial);
  assert.equal(done.receivedBytes, q8.length);
  assert.deepEqual(readFileSync(done.path), q8);
  assert.equal(existsSync(`${done.path}.part`), false);
  const fetches = hf.requests().filter((r) => r.path.startsWith('/cdn/'));
  assert.deepEqual(fetches.map((r) => r.range), [undefined, `bytes=${partial}-`]);

  // A file already in the folder isn't fetched again.
  const third = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: REPO, file });
  assert.equal(third.state, 'done');
  assert.equal(hf.requests().filter((r) => r.path.startsWith('/cdn/')).length, 2);
  // The downloaded file inspects like any other.
  const info = await kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path: done.path });
  assert.equal(info.model.name, 'Tiny Coder');

  const all = await kiln.api<ModelDownload[]>('GET', '/api/local-models/downloads');
  assert.deepEqual(all.map((d) => d.state), ['failed', 'done', 'done']);
  const unknown = await kiln.request('GET', '/api/local-models/downloads/nope');
  assert.equal(unknown.status, 404);
  const notListed = await kiln.request<{ error: string }>('POST', '/api/local-models/downloads', { repo: REPO, file: 'other.gguf' });
  assert.equal(notListed.status, 404);
  const escape = await kiln.request('POST', '/api/local-models/downloads', { repo: REPO, file: '../x.gguf' });
  assert.equal(escape.status, 400);
});

const SPLIT_REPO = 'test-org/Big-Coder-GGUF';
const SPLIT_PARTS = ['Q4_K_M/Big-Coder-Q4_K_M-00001-of-00003.gguf', 'Q4_K_M/Big-Coder-Q4_K_M-00002-of-00003.gguf', 'Q4_K_M/Big-Coder-Q4_K_M-00003-of-00003.gguf'];

test('a split GGUF is one model with its total size; it downloads every part, resumes mid-part, and inspects from part 1', async (t) => {
  const { hf, kiln, models } = await withHuggingFace(t);
  // Part 1 holds the header; the other parts hold only tensors.
  const bytes = [testGguf({ name: 'Big Coder', weightBytes: 100 * 1024 }), Buffer.alloc(150 * 1024, 0xaa), Buffer.alloc(120 * 1024, 0xbb)];
  const total = bytes.reduce((n, b) => n + b.length, 0);
  // Listed in the tree out of order, beside a part set that is missing a part.
  hf.addRepo(SPLIT_REPO, [
    { path: SPLIT_PARTS[2]!, bytes: bytes[2]! },
    { path: SPLIT_PARTS[0]!, bytes: bytes[0]! },
    { path: SPLIT_PARTS[1]!, bytes: bytes[1]! },
    { path: 'Q8_0/Big-Coder-Q8_0-00001-of-00002.gguf', bytes: bytes[0]! },
    { path: 'Big-Coder-Q2_K.gguf', bytes: bytes[0]! },
  ]);

  const listed = await kiln.api<HuggingFaceFiles>('GET', `/api/local-models/huggingface?repo=${SPLIT_REPO}`);
  assert.deepEqual(listed.files, [
    { path: 'Big-Coder-Q2_K.gguf', sizeBytes: bytes[0]!.length, quant: 'Q2_K' },
    { path: SPLIT_PARTS[0], sizeBytes: total, quant: 'Q4_K_M', parts: SPLIT_PARTS },
  ]);
  // Only the first part can be asked for.
  await kiln.api('PUT', '/api/local-server', { modelsFolder: models });
  assert.equal((await kiln.request('POST', '/api/local-models/downloads', { repo: SPLIT_REPO, file: SPLIT_PARTS[1] })).status, 404);

  // The first try is cut part-way through part 2.
  hf.cutNext(SPLIT_REPO, SPLIT_PARTS[1]!, 60 * 1024);
  const first = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: SPLIT_REPO, file: SPLIT_PARTS[0] });
  assert.deepEqual([first.path, first.totalBytes, first.parts], [join(models, 'Big-Coder-Q4_K_M-00001-of-00003.gguf'), total, SPLIT_PARTS]);
  const failed = await settled(kiln, first.id);
  assert.equal(failed.state, 'failed');
  const partial = statSync(join(models, 'Big-Coder-Q4_K_M-00002-of-00003.gguf.part')).size;
  assert.ok(partial > 0 && partial < bytes[1]!.length);
  assert.equal(failed.receivedBytes, bytes[0]!.length + partial);

  // Starting again skips part 1, resumes part 2 and fetches part 3.
  const again = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: SPLIT_REPO, file: SPLIT_PARTS[0] });
  const done = await settled(kiln, again.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.receivedBytes, total);
  assert.equal(done.resumedFromBytes, bytes[0]!.length + partial);
  for (const [i, part] of SPLIT_PARTS.entries()) {
    const local = join(models, part.split('/').pop()!);
    assert.deepEqual(readFileSync(local), bytes[i], `${local} is byte for byte part ${i + 1}`);
    assert.equal(existsSync(`${local}.part`), false);
  }
  const fetches = hf.requests().filter((r) => r.path.startsWith('/cdn/')).map((r) => [r.path.split('/').pop(), r.range]);
  assert.deepEqual(fetches, [
    ['Big-Coder-Q4_K_M-00001-of-00003.gguf', undefined],
    ['Big-Coder-Q4_K_M-00002-of-00003.gguf', undefined],
    ['Big-Coder-Q4_K_M-00002-of-00003.gguf', `bytes=${partial}-`],
    ['Big-Coder-Q4_K_M-00003-of-00003.gguf', undefined],
  ]);

  // Part 1 is the model: its header, every part's size, and names without the part number.
  const info = await kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path: done.path });
  assert.deepEqual(info.file, { path: done.path, sizeBytes: total, quant: 'Q4_K_M' });
  assert.equal(info.recommended.figures.weightsBytes, total);
  assert.equal(info.model.name, 'Big Coder');
  assert.equal(info.suggestedName, 'Big Coder Q4_K_M');
  assert.equal(info.suggestedServerModelId, 'big-coder-q4_k_m');
});

test('a download that gets no bytes for the stall timeout fails as stalled, and starting it again resumes it', async (t) => {
  const { hf, kiln, models, q8 } = await withHuggingFace(t, { env: { KILN_DOWNLOAD_STALL_MS: '400' } });
  const file = 'Q8_0/Tiny-Coder-Q8_0.gguf';
  await kiln.api('PUT', '/api/local-server', { modelsFolder: models });

  hf.stallNext(REPO, file, 100 * 1024);
  const started = Date.now();
  const first = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: REPO, file });
  const stalled = await settled(kiln, first.id);
  assert.equal(stalled.state, 'failed');
  assert.match(stalled.error!, /^The download stalled: no data for 0\.4 seconds, at .* of .*\. Start it again to resume from there\.$/);
  assert.ok(Date.now() - started >= 400, 'it waited out the timeout');
  const partial = statSync(`${stalled.path}.part`).size;
  assert.ok(partial > 0 && partial < q8.length, `the part file holds ${partial} bytes`);

  const again = await kiln.api<ModelDownload>('POST', '/api/local-models/downloads', { repo: REPO, file });
  const done = await settled(kiln, again.id);
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.resumedFromBytes, partial);
  assert.deepEqual(readFileSync(done.path), q8);
});
