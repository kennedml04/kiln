// Recommended settings for a local model, by arithmetic: the GGUF header reader and the context,
// GPU-layer and thread recommendation. Pure: no model call, no network, no real model file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, type Cleanup } from '@kiln/testing';
import {
  GgufError,
  HEADROOM_BYTES,
  KV_CACHE_BYTES_PER_ELEMENT,
  kvBytesPerToken,
  modelFacts,
  readGgufHeader,
  recommendSettings,
  recommendThreads,
  type ModelFacts,
} from '@kiln/core/local-models';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

// --- A tiny GGUF writer (v3, little-endian), enough to build test files by hand. ---

type Value =
  | { type: 'u32'; value: number }
  | { type: 'i32'; value: number }
  | { type: 'u64'; value: bigint }
  | { type: 'f32'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'str'; value: string }
  | { type: 'arr-u32'; value: number[] }
  | { type: 'arr-str'; value: string[] };

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
};

function encodeValue(v: Value): Buffer {
  switch (v.type) {
    case 'u32':
      return Buffer.concat([u32(4), u32(v.value)]);
    case 'i32': {
      const b = Buffer.alloc(4);
      b.writeInt32LE(v.value);
      return Buffer.concat([u32(5), b]);
    }
    case 'f32': {
      const b = Buffer.alloc(4);
      b.writeFloatLE(v.value);
      return Buffer.concat([u32(6), b]);
    }
    case 'bool':
      return Buffer.concat([u32(7), Buffer.from([v.value ? 1 : 0])]);
    case 'str':
      return Buffer.concat([u32(8), str(v.value)]);
    case 'u64':
      return Buffer.concat([u32(10), u64(v.value)]);
    case 'arr-u32':
      return Buffer.concat([u32(9), u32(4), u64(v.value.length), ...v.value.map(u32)]);
    case 'arr-str':
      return Buffer.concat([u32(9), u32(8), u64(v.value.length), ...v.value.map(str)]);
  }
}

function gguf(metadata: Record<string, Value>, { version = 3, magic = 'GGUF', tensorBytes = 0 } = {}): Buffer {
  const entries = Object.entries(metadata);
  return Buffer.concat([
    Buffer.from(magic, 'ascii'),
    u32(version),
    u64(7), // tensor count: the reader reports it but never reads the tensor infos
    u64(entries.length),
    ...entries.map(([key, value]) => Buffer.concat([str(key), encodeValue(value)])),
    // Stand-in for the tensor infos and weights: bytes that are not valid metadata.
    Buffer.alloc(tensorBytes, 0xff),
  ]);
}

let written = 0;
const writeTemp = (t: Cleanup, bytes: Buffer) => {
  const path = join(tempDir(t, 'kiln-gguf'), `model-${++written}.gguf`);
  writeFileSync(path, bytes);
  return path;
};

const LLAMA_META: Record<string, Value> = {
  'general.architecture': { type: 'str', value: 'llama' },
  'general.name': { type: 'str', value: 'Tiny Test' },
  'llama.block_count': { type: 'u32', value: 32 },
  'llama.context_length': { type: 'u32', value: 131072 },
  'llama.embedding_length': { type: 'u32', value: 4096 },
  'llama.attention.head_count': { type: 'u32', value: 32 },
  'llama.attention.head_count_kv': { type: 'u32', value: 8 },
  'llama.rope.freq_base': { type: 'f32', value: 500000 },
  'tokenizer.ggml.add_bos_token': { type: 'bool', value: true },
  'tokenizer.ggml.tokens': { type: 'arr-str', value: ['<s>', '</s>', 'hello'] },
};

// --- The GGUF header reader ---

test('reads the metadata from a GGUF header and stops before the tensor data', async (t) => {
  const path = writeTemp(t,gguf(LLAMA_META, { tensorBytes: 4 * MiB }));
  const header = await readGgufHeader(path);
  assert.equal(header.version, 3);
  assert.equal(header.tensorCount, 7);
  assert.equal(header.fileBytes, 4 * MiB + header.headerBytes);
  assert.ok(header.headerBytes < 1024, `the reader stopped at byte ${header.headerBytes}`);
  assert.equal(header.metadata['general.architecture'], 'llama');
  assert.equal(header.metadata['llama.block_count'], 32);
  assert.equal(header.metadata['llama.rope.freq_base'], 500000);
  assert.equal(header.metadata['tokenizer.ggml.add_bos_token'], true);
  assert.deepEqual(header.metadata['tokenizer.ggml.tokens'], ['<s>', '</s>', 'hello']);
});

test('reads 64-bit and signed values, and per-layer arrays', async (t) => {
  const path = writeTemp(t,
    gguf({
      'general.architecture': { type: 'str', value: 'qwen3' },
      'qwen3.block_count': { type: 'u64', value: 4n },
      'qwen3.context_length': { type: 'i32', value: 40960 },
      'qwen3.embedding_length': { type: 'u32', value: 2048 },
      'qwen3.attention.head_count': { type: 'u32', value: 16 },
      'qwen3.attention.head_count_kv': { type: 'arr-u32', value: [4, 0, 4, 8] },
      'qwen3.attention.key_length': { type: 'u32', value: 128 },
      'qwen3.attention.value_length': { type: 'u32', value: 128 },
    }),
  );
  const header = await readGgufHeader(path);
  assert.equal(header.metadata['qwen3.block_count'], 4);
  assert.equal(header.metadata['qwen3.context_length'], 40960);
  assert.deepEqual(header.metadata['qwen3.attention.head_count_kv'], [4, 0, 4, 8]);
  // A per-layer KV head count averages over the layers, so the KV total is the sum.
  assert.deepEqual(modelFacts(header), {
    architecture: 'qwen3',
    layerCount: 4,
    kvHeadCount: 4,
    keyLength: 128,
    valueLength: 128,
    trainingContext: 40960,
  });
});

test('model facts work out the head size from the embedding when the key length is missing', async (t) => {
  const header = await readGgufHeader(writeTemp(t,gguf(LLAMA_META)));
  assert.deepEqual(modelFacts(header), {
    architecture: 'llama',
    layerCount: 32,
    kvHeadCount: 8,
    keyLength: 128,
    valueLength: 128,
    trainingContext: 131072,
  });
});

test('refuses a file that is not GGUF, an old version, a truncated header and missing keys', async (t) => {
  await assert.rejects(readGgufHeader(writeTemp(t,gguf(LLAMA_META, { magic: 'GGML' }))), (err: unknown) => {
    assert.ok(err instanceof GgufError);
    assert.match(err.message, /not a GGUF file/);
    return true;
  });
  await assert.rejects(readGgufHeader(writeTemp(t,gguf(LLAMA_META, { version: 1 }))), /GGUF version 1/);
  await assert.rejects(readGgufHeader(writeTemp(t,gguf(LLAMA_META).subarray(0, 60))), /ends inside its header/);
  const { 'llama.block_count': _dropped, ...noLayers } = LLAMA_META;
  const header = await readGgufHeader(writeTemp(t,gguf(noLayers)));
  assert.throws(() => modelFacts(header), /llama\.block_count/);
});

// --- The recommendation ---

// A Llama-3-8B-like model: 32 layers, 8 KV heads of 128. At f16 that's
// 32 * 8 * (128 + 128) * 2 = 131072 bytes of KV cache a token: 2 GiB at 16K, 8 GiB at 64K.
const LLAMA_8B: ModelFacts = {
  architecture: 'llama',
  layerCount: 32,
  kvHeadCount: 8,
  keyLength: 128,
  valueLength: 128,
  trainingContext: 131072,
};

const gpu = (usedGiB: number, totalGiB = 24) => ({ memoryUsedMiB: usedGiB * 1024, memoryTotalMiB: totalGiB * 1024 });

test('the KV cache per token comes from layers, KV heads, head sizes and the cache type', () => {
  assert.equal(kvBytesPerToken(LLAMA_8B, 'f16'), 131072);
  assert.equal(kvBytesPerToken(LLAMA_8B, 'q8_0'), 131072 * (34 / 32 / 2));
  assert.equal(kvBytesPerToken(LLAMA_8B, 'q4_0'), 131072 * (18 / 32 / 2));
  assert.equal(KV_CACHE_BYTES_PER_ELEMENT.f32, 4);
  assert.equal(HEADROOM_BYTES, 1.5 * GiB);
});

test('fits fully: the largest context that leaves 1.5 GB free, with every layer on the GPU', () => {
  // 8 GiB weights, nothing else on a 24 GiB card: 22.5 GiB usable.
  // 64K: 8 + 8 = 16 GiB fits; 128K: 8 + 16 = 24 GiB doesn't.
  const r = recommendSettings({ fileBytes: 8 * GiB, facts: LLAMA_8B, kvCacheType: 'f16', gpu: gpu(0), cpuThreads: 16 });
  assert.equal(r.contextSize, 65536);
  assert.equal(r.gpuLayers, 33);
  assert.equal(r.offloaded, false);
  assert.equal(r.kvCacheType, 'f16');
  assert.equal(r.threads, 8);
  assert.equal(r.reason, 'fits 16 of 24 GB at 64K; 128K would take 24 GB, leaving under 1.5 GB free');
  assert.deepEqual(r.numbers, {
    weightsBytes: 8 * GiB,
    kvBytesPerToken: 131072,
    kvBytes: 8 * GiB,
    neededBytes: 16 * GiB,
    onGpuBytes: 16 * GiB,
    usedByOthersBytes: 0,
    totalBytes: 24 * GiB,
    freeBytes: 24 * GiB,
    headroomBytes: 1.5 * GiB,
    layerCount: 32,
    trainingContext: 131072,
  });
});

test('a smaller KV cache type fits a larger context', () => {
  const r = recommendSettings({ fileBytes: 8 * GiB, facts: LLAMA_8B, kvCacheType: 'q8_0', gpu: gpu(0), cpuThreads: 16 });
  // 128K at q8_0: 16 GiB * 34/64 = 8.5 GiB of KV, 16.5 GiB in all.
  assert.equal(r.contextSize, 131072);
  assert.equal(r.numbers.kvBytes, 8.5 * GiB);
  assert.equal(r.reason, "fits 16.5 of 24 GB at 128K, the model's training context");
});

test('fits only a smaller context when other programs hold VRAM', () => {
  // 10 GiB used by others leaves 12.5 GiB usable: 16K (10) and 32K (12) fit, 64K (16) doesn't.
  const r = recommendSettings({ fileBytes: 8 * GiB, facts: LLAMA_8B, kvCacheType: 'f16', gpu: gpu(10), cpuThreads: 16 });
  assert.equal(r.contextSize, 32768);
  assert.equal(r.gpuLayers, 33);
  assert.equal(r.offloaded, false);
  assert.equal(r.numbers.usedByOthersBytes, 10 * GiB);
  assert.equal(r.numbers.freeBytes, 14 * GiB);
  assert.equal(r.reason, 'fits 22 of 24 GB at 32K; 64K would take 26 GB, leaving under 1.5 GB free');
});

test('needs offload: when 16K does not fit, only as many layers as fit go on the GPU', () => {
  // 40 GiB of weights on a 24 GiB card. At 16K each of the 33 offload slots (32 layers + output)
  // costs 40/33 GiB of weights, and each of the 32 layers 2/32 GiB of KV cache.
  const r = recommendSettings({ fileBytes: 40 * GiB, facts: LLAMA_8B, kvCacheType: 'f16', gpu: gpu(0), cpuThreads: 16 });
  assert.equal(r.contextSize, 16384);
  assert.equal(r.offloaded, true);
  // n * (40/33 + 2/32) <= 22.5  =>  n <= 17.6
  assert.equal(r.gpuLayers, 17);
  assert.equal(r.numbers.neededBytes, 42 * GiB);
  assert.equal(r.reason, '16K needs 42 GB with every layer on the GPU; 22.5 GB is free after the 1.5 GB headroom, so 17 of 33 layers fit (21.7 of 24 GB)');
});

test('needs offload with nothing on the GPU when no layer fits', () => {
  const r = recommendSettings({ fileBytes: 40 * GiB, facts: LLAMA_8B, kvCacheType: 'f16', gpu: gpu(23), cpuThreads: 16 });
  assert.equal(r.gpuLayers, 0);
  assert.equal(r.offloaded, true);
  assert.equal(r.reason, '16K needs 42 GB with every layer on the GPU; 0 GB is free after the 1.5 GB headroom, so no layer fits and it runs on the CPU');
});

test('capped by the training context, even with VRAM to spare', () => {
  const facts = { ...LLAMA_8B, trainingContext: 32768 };
  const r = recommendSettings({ fileBytes: 4 * GiB, facts, kvCacheType: 'f16', gpu: gpu(0, 80), cpuThreads: 16 });
  assert.equal(r.contextSize, 32768);
  assert.equal(r.offloaded, false);
  assert.equal(r.reason, "fits 8 of 80 GB at 32K, the model's training context");
});

test('a training context below 16K is the context, and one between steps stops at the step below it', () => {
  const short = recommendSettings({ fileBytes: 4 * GiB, facts: { ...LLAMA_8B, trainingContext: 8192 }, kvCacheType: 'f16', gpu: gpu(0), cpuThreads: 16 });
  assert.equal(short.contextSize, 8192);
  assert.equal(short.reason, "fits 5 of 24 GB at 8K, the model's training context");
  const between = recommendSettings({ fileBytes: 4 * GiB, facts: { ...LLAMA_8B, trainingContext: 40960 }, kvCacheType: 'f16', gpu: gpu(0), cpuThreads: 16 });
  assert.equal(between.contextSize, 32768);
  assert.equal(between.reason, "fits 8 of 24 GB at 32K; the model's training context is 40K");
});

test('with no VRAM figures from the GPU monitor, everything stays on the CPU at 16K', () => {
  const r = recommendSettings({
    fileBytes: 8 * GiB,
    facts: LLAMA_8B,
    kvCacheType: 'f16',
    gpu: { memoryUsedMiB: null, memoryTotalMiB: null },
    cpuThreads: 16,
  });
  assert.equal(r.contextSize, 16384);
  assert.equal(r.gpuLayers, 0);
  assert.equal(r.offloaded, true);
  assert.equal(r.numbers.totalBytes, null);
  assert.equal(r.reason, 'the GPU monitor reported no VRAM figures, so every layer stays on the CPU at 16K');
});

test('threads: half the logical CPUs, at least one', () => {
  assert.equal(recommendThreads(16), 8);
  assert.equal(recommendThreads(12), 6);
  assert.equal(recommendThreads(3), 1);
  assert.equal(recommendThreads(1), 1);
});
