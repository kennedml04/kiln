// Add a model (local-first Ticket 06), through the core API: a GGUF file's facts and recommended
// settings, a Hugging Face repo's GGUF files, and a download that resumes. Hugging Face is a fake
// on a local port; no test reaches huggingface.co.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HuggingFaceFiles, LocalServerSettings, ModelDownload, ModelInspection } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { startFakeHuggingFace } from '@kiln/testing/fake-hugging-face';
import { testGguf } from '@kiln/testing/test-gguf';

const REPO = 'test-org/Tiny-Coder-GGUF';

async function withHuggingFace(t: Cleanup, options: { chunkDelayMs?: number } = {}) {
  const hf = await startFakeHuggingFace(t, { chunkBytes: 8 * 1024, ...options });
  const q4 = testGguf({ name: 'Tiny Coder', weightBytes: 200 * 1024 });
  const q8 = testGguf({ name: 'Tiny Coder', weightBytes: 400 * 1024 });
  hf.addRepo(REPO, [
    { path: 'Tiny-Coder-Q4_K_M.gguf', bytes: q4 },
    { path: 'Q8_0/Tiny-Coder-Q8_0.gguf', bytes: q8 },
  ]);
  const kiln = await startTestKiln(t, { env: { KILN_HUGGINGFACE_URL: hf.url } });
  const models = tempDir(t, 'kiln-models');
  return { hf, kiln, models, q4, q8 };
}

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
