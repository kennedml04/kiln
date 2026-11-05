# 06: Settings → Models: Add a model

**What to build:** A Settings → Models page in the shell:
- the variant list (state, last smoke test, enable, disable, remove);
- Add a model: pick a GGUF on disk, or a Hugging Face repo and a quant from its file list;
- the recommended settings from 05, each with its reason and editable;
- Save, which writes the entry, reloads the server and shows the smoke test result.

"Add another variant" copies an existing variant's model so only the changed settings need typing. A Hugging Face download uses the public HTTP API, resumes, asks first with the file name and size, and saves to a models folder set in Settings. User stories 1–7 in `spec.md`.

**Blocked by:** 04, 05

**Status:** resolved

- [x] Adding a GGUF from disk ends with a smoke-tested variant, with no YAML edited by hand
- [x] A Hugging Face download shows the size and starts only after confirmation; an interrupted download resumes
- [x] Recommendations show their reasons and can be changed before saving
- [x] Add another variant prefills the model and the last settings
- [x] Shell tests drive the page against a fake local server

**As built:** The page is `/settings/models` (`packages/shell/src/work/ModelsPage.tsx`), linked from Settings. It has three parts: the local server form (config path, URL and a new `modelsFolder` Setting, none with a default), the variant table (hand-written entries included), and Add a model. Remove asks first, inline. The core has new Admin-only routes under `/api/local-models/` (`packages/core/src/local/models.ts`):
- `inspect` reads a GGUF header and returns its facts and ticket 05's recommendation, with a reason for each field. It sizes for the GPU with the most free VRAM in the GPU monitor Widget's panel; with no reading, every layer stays on the CPU.
- `huggingface?repo=` lists a public repo's `.gguf` files with their sizes through the tree API, with no token.
- `downloads` starts a download (only on the person's confirm) and reports its progress, which the shell polls. A download writes `<file>.part`, resumes with `Range`, and lands in the models folder under the file's base name.

Save posts to ticket 04's `POST /api/variants` and shows the smoke test's result. A changed KV cache type asks again, and the fields the person has not touched follow the new recommendation. The Hugging Face base URL is set by `KILN_HUGGINGFACE_URL`; the test harness points it at a closed local port, so no test reaches huggingface.co. The fakes are in `@kiln/testing`: `fake-hugging-face` (with Range support and cut-offs) and `test-gguf`. The tests are in:
- `packages/core/test/local-models.test.ts`
- `packages/shell/test/models-page.test.ts`
- the GPU monitor test
