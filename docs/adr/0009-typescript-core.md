# TypeScript core (Node server, React Shell); Widgets in any language

The core is TypeScript end to end: a Node server and a React Shell. That way the core API, the Widget SDK and the Shell share one set of types, and the compiler checks the Widget contract. The Agent SDKs we wrap (OpenCode's SDK, the Claude Agent SDK) are TypeScript-first, and React suits declarative panels. Widgets are separate processes, so they can be written in any language. A TypeScript Widget SDK ships first, then a small Python one, so existing private Python Widgets can stay Python. This reverses the old board's stack, a hand-rolled Python `http.server` with vanilla JS and no build step.

## Considered options

- **Python core (FastAPI) with a TypeScript frontend**: familiar from the old board, but the most important contract would span two languages and two sets of types. Rejected.
