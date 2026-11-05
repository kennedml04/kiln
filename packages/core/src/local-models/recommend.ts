// Recommended settings for a local model variant, by plain arithmetic: no model call, no network.
//
// Inputs: the GGUF file's size (about the weights' size), its metadata (layers, KV heads, head
// sizes, training context), the KV cache type, the GPU's VRAM as the GPU monitor Widget reports it
// (`memoryUsedMiB`, `memoryTotalMiB`) and the number of logical CPUs.
//
// The formula:
//   KV cache bytes per token = layers x KV heads x (key length + value length) x bytes per element
//   needed VRAM at a context = weights + KV bytes per token x context
//   usable VRAM              = (total - used by other programs) - HEADROOM_BYTES
// Kiln takes the largest context from 16K, 32K, 64K, 128K ... (never past the training context)
// whose needed VRAM fits the usable VRAM with every layer on the GPU. When even the first step
// doesn't fit, it stays at that step and offloads: llama-server counts the repeating layers plus
// the output layer (layers + 1), the weights are spread evenly over those, and each repeating layer
// on the GPU holds its share of the KV cache. The headroom covers llama.cpp's compute buffers and
// the CUDA context, which this formula doesn't count. Sliding-window caches (some models keep a
// short cache on most layers) are counted as full ones, so the figure errs on the safe side.
import type { GgufHeader, GgufValue } from './gguf.ts';
import { GgufError } from './gguf.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** VRAM left free after loading, for compute buffers and everything else on the GPU. */
export const HEADROOM_BYTES = 1.5 * GiB;
/** The smallest context Kiln recommends; it doubles from here. */
export const FIRST_CONTEXT = 16 * 1024;

/**
 * Bytes per cached element for llama.cpp's KV cache types (`--cache-type-k/-v`). A quantized type
 * stores blocks of 32 values: q8_0 is 32 bytes plus a 2-byte scale, q4_0 16 bytes plus 2, and so on.
 */
export const KV_CACHE_BYTES_PER_ELEMENT = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 18 / 32,
} as const;

export type KvCacheType = keyof typeof KV_CACHE_BYTES_PER_ELEMENT;

/** The model's shape, from its GGUF metadata. */
export interface ModelFacts {
  architecture: string;
  /** Repeating layers (`<arch>.block_count`). */
  layerCount: number;
  /** KV heads a layer; the mean over the layers when the model gives one count a layer. */
  kvHeadCount: number;
  /** Elements a key and a value hold per head. */
  keyLength: number;
  valueLength: number;
  /** The context the model was trained for (`<arch>.context_length`). */
  trainingContext: number;
}

/** What the GPU monitor Widget reports for a GPU; null when the driver doesn't say. */
export interface GpuMemory {
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
}

export interface RecommendInput {
  /** The GGUF file's size in bytes. */
  fileBytes: number;
  facts: ModelFacts;
  kvCacheType: KvCacheType;
  gpu: GpuMemory;
  /** Logical CPUs on this machine (os.availableParallelism()). */
  cpuThreads: number;
}

/** The figures a recommendation came from, in bytes. VRAM figures are null when unknown. */
export interface RecommendationNumbers {
  weightsBytes: number;
  kvBytesPerToken: number;
  /** KV cache at the recommended context, every layer counted. */
  kvBytes: number;
  /** Weights plus KV cache, every layer on the GPU. */
  neededBytes: number;
  /** What the recommended settings put on the GPU. */
  onGpuBytes: number;
  usedByOthersBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  headroomBytes: number;
  layerCount: number;
  trainingContext: number;
}

export interface Recommendation {
  contextSize: number;
  /** llama-server's `--n-gpu-layers`: layers + 1 puts every layer, the output one too, on the GPU. */
  gpuLayers: number;
  kvCacheType: KvCacheType;
  threads: number;
  /** True when some layers stay on the CPU. */
  offloaded: boolean;
  numbers: RecommendationNumbers;
  /** One line, e.g. "fits 22.1 of 24 GB at 64K". */
  reason: string;
}

/** The model's shape from a GGUF header. Throws GgufError naming a missing key. */
export function modelFacts(header: Pick<GgufHeader, 'metadata'>): ModelFacts {
  const meta = header.metadata;
  const architecture = meta['general.architecture'];
  if (typeof architecture !== 'string') throw new GgufError('the GGUF metadata has no general.architecture');
  const key = (name: string) => `${architecture}.${name}`;
  const optional = (name: string) => numberOf(meta[key(name)], key(name));
  const required = (name: string) => {
    const value = optional(name);
    if (value === undefined) throw new GgufError(`the GGUF metadata has no ${key(name)}`);
    return value;
  };
  const layerCount = required('block_count');
  const trainingContext = required('context_length');
  const headCount = required('attention.head_count');
  const kvHeadCount = optional('attention.head_count_kv') ?? headCount;
  const keyLength = optional('attention.key_length') ?? required('embedding_length') / headCount;
  const valueLength = optional('attention.value_length') ?? keyLength;
  return { architecture, layerCount, kvHeadCount, keyLength, valueLength, trainingContext };
}

/** A number, or the mean of a per-layer array of numbers. */
function numberOf(value: GgufValue | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')) {
    return (value as number[]).reduce((a, b) => a + b, 0) / value.length;
  }
  throw new GgufError(`the GGUF metadata's ${name} is not a number`);
}

export const kvBytesPerToken = (facts: ModelFacts, kvCacheType: KvCacheType) =>
  facts.layerCount * facts.kvHeadCount * (facts.keyLength + facts.valueLength) * KV_CACHE_BYTES_PER_ELEMENT[kvCacheType];

/**
 * Threads for llama-server: half the logical CPUs, at least one. That is about the physical core
 * count on CPUs with two threads a core; token generation gets slower past the physical cores.
 */
export const recommendThreads = (logicalCpus: number) => Math.max(1, Math.floor(logicalCpus / 2));

/** 16K, 32K, 64K ... up to the training context; the training context alone when it is below 16K. */
function contextSteps(trainingContext: number): number[] {
  if (trainingContext < FIRST_CONTEXT) return [trainingContext];
  const steps: number[] = [];
  for (let c = FIRST_CONTEXT; c <= trainingContext; c *= 2) steps.push(c);
  return steps;
}

const gb = (bytes: number) => String(Number((bytes / GiB).toFixed(1)));
const k = (tokens: number) => `${Number((tokens / 1024).toFixed(1))}K`;

export function recommendSettings(input: RecommendInput): Recommendation {
  const { fileBytes: weightsBytes, facts, kvCacheType, gpu } = input;
  const perToken = kvBytesPerToken(facts, kvCacheType);
  const steps = contextSteps(facts.trainingContext);
  const needed = (context: number) => weightsBytes + perToken * context;
  const allLayers = facts.layerCount + 1;
  const threads = recommendThreads(input.cpuThreads);

  const result = (
    contextSize: number,
    gpuLayers: number,
    onGpuBytes: number,
    vram: { used: number; total: number } | null,
    reason: string,
  ): Recommendation => ({
    contextSize,
    gpuLayers,
    kvCacheType,
    threads,
    offloaded: gpuLayers < allLayers,
    numbers: {
      weightsBytes,
      kvBytesPerToken: perToken,
      kvBytes: perToken * contextSize,
      neededBytes: needed(contextSize),
      onGpuBytes,
      usedByOthersBytes: vram ? vram.used : null,
      totalBytes: vram ? vram.total : null,
      freeBytes: vram ? vram.total - vram.used : null,
      headroomBytes: HEADROOM_BYTES,
      layerCount: facts.layerCount,
      trainingContext: facts.trainingContext,
    },
    reason,
  });

  const first = steps[0]!;
  if (gpu.memoryUsedMiB === null || gpu.memoryTotalMiB === null) {
    return result(first, 0, 0, null, `the GPU monitor reported no VRAM figures, so every layer stays on the CPU at ${k(first)}`);
  }
  const vram = { used: gpu.memoryUsedMiB * MiB, total: gpu.memoryTotalMiB * MiB };
  const usable = vram.total - vram.used - HEADROOM_BYTES;
  const of = (onGpu: number) => `${gb(onGpu + vram.used)} of ${gb(vram.total)} GB`;

  const fitting = steps.filter((context) => needed(context) <= usable);
  if (fitting.length > 0) {
    const context = fitting.at(-1)!;
    const next = steps[fitting.length];
    const why =
      next !== undefined
        ? `; ${k(next)} would take ${gb(needed(next) + vram.used)} GB, leaving under ${gb(HEADROOM_BYTES)} GB free`
        : context === facts.trainingContext
          ? ", the model's training context"
          : `; the model's training context is ${k(facts.trainingContext)}`;
    return result(context, allLayers, needed(context), vram, `fits ${of(needed(context))} at ${k(context)}${why}`);
  }

  // Offload: each layer on the GPU takes its share of the weights and of the KV cache.
  const perLayer = weightsBytes / allLayers + (perToken * first) / facts.layerCount;
  const room = Math.max(0, usable);
  const gpuLayers = Math.min(facts.layerCount, Math.floor(room / perLayer));
  const onGpu = gpuLayers * perLayer;
  const head = `${k(first)} needs ${gb(needed(first))} GB with every layer on the GPU; ${gb(room)} GB is free after the ${gb(HEADROOM_BYTES)} GB headroom, so`;
  const tail =
    gpuLayers === 0 ? 'no layer fits and it runs on the CPU' : `${gpuLayers} of ${allLayers} layers fit (${of(onGpu)})`;
  return result(first, gpuLayers, onGpu, vram, `${head} ${tail}`);
}
