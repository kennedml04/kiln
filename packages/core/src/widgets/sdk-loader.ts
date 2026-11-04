// Loaded with `--import` into every Node Widget the host starts. It points `@kiln/widget-sdk` at
// the running core's own copy, so a Widget gets the SDK of the core API it talks to and needs no
// copy of its own (a git checkout has none). Every other import resolves as Node would.
import { registerHooks } from 'node:module';

const SDK = '@kiln/widget-sdk';
const sdkUrl = import.meta.resolve(SDK);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === SDK) return { url: sdkUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
