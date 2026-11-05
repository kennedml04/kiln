# 06: Settings → Models: Add a model

**What to build:** A Settings → Models page in the shell:
- the variant list (state, last smoke test, enable, disable, remove);
- Add a model: pick a GGUF on disk, or a Hugging Face repo and a quant from its file list;
- the recommended settings from 05, each with its reason and editable;
- Save, which writes the entry, reloads the server and shows the smoke test result.

"Add another variant" copies an existing variant's model so only the changed settings need typing. A Hugging Face download uses the public HTTP API, resumes, asks first with the file name and size, and saves to a models folder set in Settings. User stories 1–7 in `spec.md`.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] Adding a GGUF from disk ends with a smoke-tested variant, with no YAML edited by hand
- [ ] A Hugging Face download shows the size and starts only after confirmation; an interrupted download resumes
- [ ] Recommendations show their reasons and can be changed before saving
- [ ] Add another variant prefills the model and the last settings
- [ ] Shell tests drive the page against a fake local server
