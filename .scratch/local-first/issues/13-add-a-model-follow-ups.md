# 13: Add a model follow-ups

**What to build:** Three fixes left over from ticket 06's open questions:
1. **Structured VRAM:** the GPU monitor Widget's panel gives each GPU's used and total memory as numbers (MiB), beside its display text. `POST /api/local-models/inspect` reads those numbers and stops parsing the "12.0 / 24.0" string.
2. **Split GGUF files:** a Hugging Face repo's `-00001-of-0000N` files are listed as one model with their total size. Picking it downloads every part, and the variant points at the first part (llama-server loads the rest).
3. **Download stall timeout:** a download that gets no bytes for 60 seconds fails with "The download stalled", and the existing "Resume the download" button picks it up from the `.part` file.

Extra flags keep `--jinja` as the default for new variants (Claude Code's tool calls need the chat template).

**Blocked by:** 06

**Status:** resolved

- [x] The recommendation uses the GPU monitor's numeric reading, tested with a panel whose display text changes wording
- [x] A fake repo with a three-part GGUF lists one model with the total size, downloads all parts, and saves a variant on part 1
- [x] A fake download that stops sending bytes fails as stalled after the timeout (short timeout in tests) and resumes

**As built:**
- **Structured VRAM:** a panel card has a new optional `data` field (an object of plain values, checked by the core, not drawn by the Shell). The GPU monitor's `gpu-<n>` cards carry `data: { memoryUsedMiB, memoryTotalMiB }`, and `gpuFromPanels` reads only those; display text alone (even "12.0 / 24.0") is no reading, nor is a null number.
- **Split GGUF:** `packages/core/src/local/split-gguf.ts` names the parts. The Hugging Face listing shows a split once, on part 1, with the total size and `parts`; a split missing a part is left out. A download fetches each part into the models folder in turn (each with its own `.part` file, skipping parts already there), counting bytes across all of them. Inspect and the variant list size part 1 as every part beside it, and the suggested name and id drop the part number. The variant's `-m` is part 1.
- **Stall timeout:** a part that gets no bytes for 60 seconds (`KILN_DOWNLOAD_STALL_MS` shortens it in tests) is aborted, and the download fails with "The download stalled: no data for 60 seconds, at X of Y. Start it again to resume from there." Resume uses the existing Range path.
- `--jinja` stays the default extra flag; the split test checks it.
- Fakes: `stallNext` in `fake-hugging-face`. Tests: `packages/core/test/local-models.test.ts` (numeric VRAM through a hand-published panel, split listing, download, resume and inspect, stall), `packages/shell/test/models-page.test.ts` (split pick, stalled part resumed, variant saved on part 1), `packages/core/test/widget-panels.test.ts` (card data checked), the GPU monitor test (card data).
