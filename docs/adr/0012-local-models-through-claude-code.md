# Local models run through the Claude Code Agent; OpenCode is removed

This amends 0004 and 0009, which stay as written. Kiln has one first-party Agent, the Claude Code Widget, and it runs local models as well as Claude. A local Session starts Claude Code with the local model server (llama-swap in front of llama-server) as its Anthropic base URL, its own empty config folder and no Anthropic credential in its environment. The OpenCode Widget is deleted: the owner uses only Claude Code for now, its real run was never done, and keeping a second Agent alive costs a second Policy translation, a second set of trailer guards and a second test suite. With one Agent, cloud and local Sessions share all three.

0004 still holds: the core knows Agents only through the Agent interface and ships with none, so a second Agent Widget can come back later (a second cloud provider is the likely reason). 0009's mention of OpenCode's SDK no longer applies; the core stays TypeScript for the other reasons it gives.

## Considered options

- **Keep OpenCode for local models**: works with any OpenAI-shaped server, but it is a second Agent to maintain when only Claude Code is in use. Rejected.
- **A second cloud provider's Agent now**: could bring the monthly cost down, but it is left for later.
