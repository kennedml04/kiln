// Local models: reading GGUF files and recommending a variant's settings from them.
export { readGgufHeader, GgufError, type GgufHeader, type GgufValue, type GgufArraySummary } from './gguf.ts';
export {
  recommendSettings,
  recommendThreads,
  modelFacts,
  kvBytesPerToken,
  HEADROOM_BYTES,
  FIRST_CONTEXT,
  KV_CACHE_BYTES_PER_ELEMENT,
  type KvCacheType,
  type ModelFacts,
  type GpuMemory,
  type RecommendInput,
  type Recommendation,
  type RecommendationNumbers,
} from './recommend.ts';
