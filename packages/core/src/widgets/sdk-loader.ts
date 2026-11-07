// Loaded with `--import` into every Node Widget the host starts. It points `@kiln/widget-sdk` at
// the running core's own copy, so a Widget gets the SDK of the core API it talks to and needs no
// copy of its own (a git checkout has none). Every other import resolves as Node would.
import { registerHooks } from 'node:module';

const SDK = '@kiln/widget-sdk';
const sdkUrl = import.meta.resolve(SDK);
// Node-only subpaths of the SDK (not in the browser-safe index), e.g. `@kiln/widget-sdk/tool-classifier`.
const SUBPATHS: Record<string, string> = { [`${SDK}/tool-classifier`]: import.meta.resolve(`${SDK}/tool-classifier`) };

registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(SUBPATHS, specifier)) return { url: SUBPATHS[specifier]!, shortCircuit: true };
    if (specifier === SDK) return { url: sdkUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
