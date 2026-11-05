# 05: Recommended settings for a model, by arithmetic

**What to build:** A pure module that recommends a variant's settings from:
- the GGUF file's size and metadata (layers, KV heads, head size, training context);
- the KV cache type;
- the GPU's free VRAM, as the GPU monitor Widget reports it.

It picks the largest context from 16K, 32K, 64K, 128K and so on that leaves 1.5 GB of VRAM headroom with every layer on the GPU. When even 16K doesn't fit, it offloads layers. It never goes past the model's training context. Each recommendation carries its numbers and a one-line reason ("fits 22.1 of 24 GB at 64K"). It needs no model call. Reading GGUF metadata is part of this ticket. See "Variants and Add a model" in `spec.md`.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Unit tests on fixed metadata and VRAM figures cover: fits fully, fits only a smaller context, needs offload, capped by the training context
- [ ] Every recommendation shows the numbers it came from
- [ ] GGUF metadata is read from a file header without loading the weights
