# 05: Recommended settings for a model, by arithmetic

**What to build:** A pure module that recommends a variant's settings from:
- the GGUF file's size and metadata (layers, KV heads, head size, training context);
- the KV cache type;
- the GPU's free VRAM, as the GPU monitor Widget reports it.

It picks the largest context from 16K, 32K, 64K, 128K and so on that leaves 1.5 GB of VRAM headroom with every layer on the GPU. When even 16K doesn't fit, it offloads layers. It never goes past the model's training context. Each recommendation carries its numbers and a one-line reason ("fits 22.1 of 24 GB at 64K"). It needs no model call. Reading GGUF metadata is part of this ticket. See "Variants and Add a model" in `spec.md`.

**Blocked by:** None

**Status:** resolved

**As built:** `packages/core/src/local-models/` (imported as `@kiln/core/local-models`). `gguf.ts` exports `readGgufHeader(path)`, which reads GGUF v2/v3 metadata in 64 KB chunks and stops where the tensor infos begin (arrays over 1024 items, like the vocabulary, are kept only as their size), and `GgufError`. `recommend.ts` exports `modelFacts(header)` (layers, KV heads, key and value lengths, training context; a per-layer KV head array is averaged), `kvBytesPerToken(facts, kvCacheType)`, `recommendSettings({ fileBytes, facts, kvCacheType, gpu, cpuThreads })`, `recommendThreads(logicalCpus)` (half the logical CPUs, at least one) and the constants `HEADROOM_BYTES`, `FIRST_CONTEXT` and `KV_CACHE_BYTES_PER_ELEMENT`. KV bytes per token = layers x KV heads x (key + value length) x bytes per element; the context is the largest step with weights + KV within free VRAM less 1.5 GB. When 16K doesn't fit, the weights are spread over layers + 1 offload slots and as many as fit go on the GPU. `gpu` takes the GPU monitor's `memoryUsedMiB` and `memoryTotalMiB`; when either is null, every layer stays on the CPU. Each recommendation carries `numbers` (bytes) and a one-line `reason`. Tests: `packages/core/test/recommend-settings.test.ts`, on GGUF files built in the test.

- [x] Unit tests on fixed metadata and VRAM figures cover: fits fully, fits only a smaller context, needs offload, capped by the training context
- [x] Every recommendation shows the numbers it came from
- [x] GGUF metadata is read from a file header without loading the weights
