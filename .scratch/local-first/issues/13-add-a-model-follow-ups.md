# 13: Add a model follow-ups

**What to build:** Three fixes left over from ticket 06's open questions:
1. **Structured VRAM:** the GPU monitor Widget's panel gives each GPU's used and total memory as numbers (MiB), beside its display text. `POST /api/local-models/inspect` reads those numbers and stops parsing the "12.0 / 24.0" string.
2. **Split GGUF files:** a Hugging Face repo's `-00001-of-0000N` files are listed as one model with their total size. Picking it downloads every part, and the variant points at the first part (llama-server loads the rest).
3. **Download stall timeout:** a download that gets no bytes for 60 seconds fails with "The download stalled", and the existing "Resume the download" button picks it up from the `.part` file.

Extra flags keep `--jinja` as the default for new variants (Claude Code's tool calls need the chat template).

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The recommendation uses the GPU monitor's numeric reading, tested with a panel whose display text changes wording
- [ ] A fake repo with a three-part GGUF lists one model with the total size, downloads all parts, and saves a variant on part 1
- [ ] A fake download that stops sending bytes fails as stalled after the timeout (short timeout in tests) and resumes
