// The GPU monitor Widget process. It reads the GPUs through nvidia-smi every few seconds and
// publishes its "gpus" panel whenever the reading changes. It takes no actions on the GPU.
//
// It talks to the core over the plain Widget API with `fetch` and imports only types from the SDK
// (erased at run time), so it runs from a clone of the public repo that has no node_modules.
//
// Config (KILN_WIDGET_CONFIG), both optional:
//   nvidiaSmi   the command to read with, default ["nvidia-smi"] ("node" first = this Node)
//   intervalMs  how often to read, default 2000
import type { PanelContent, WidgetCommand } from '@kiln/widget-sdk';
import { gpuPanel, unavailablePanel } from './panel.ts';
import { nvidiaSmi, readNvidiaSmi, ToolFailed } from './nvidia-smi.ts';

interface GpuMonitorConfig {
  nvidiaSmi?: string[];
  intervalMs?: number;
}

const PANEL = 'gpus';
const env = process.env;
const api = env.KILN_API_URL;
const config = JSON.parse(env.KILN_WIDGET_CONFIG || '{}') as GpuMonitorConfig;
const intervalMs = Math.max(100, config.intervalMs ?? 2000);

const auth = { authorization: `Bearer ${env.KILN_WIDGET_TOKEN}` };
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
};

const run = nvidiaSmi(config.nvidiaSmi);

let last = '';
async function publish(content: PanelContent) {
  const json = JSON.stringify(content);
  if (json === last) return;
  await call('PUT', `/api/widget/panels/${PANEL}`, content);
  last = json;
}

async function tick() {
  try {
    let content: PanelContent;
    try {
      content = gpuPanel(await readNvidiaSmi(run));
    } catch (err) {
      if (!(err instanceof ToolFailed)) throw err;
      content = unavailablePanel(err.message);
    }
    await publish(content);
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
  }
  setTimeout(() => void tick(), intervalMs);
}

/** Calls `onData` with the data of each SSE message until the stream ends. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (data) onData(data);
      }
    }
  } catch {
    // The core went away.
  }
}

await call('POST', '/api/widget/register', { agents: [] });
const stream = await fetch(`${api}/api/widget/commands`, { headers: auth });
if (!stream.ok || !stream.body) throw new Error(`Command stream failed: ${stream.status}`);
await call('POST', '/api/widget/ready');
void tick();
await readSse(stream.body, (data) => {
  const command = JSON.parse(data) as WidgetCommand;
  if (command.type === 'widget.stop') process.exit(0);
});
// No command stream means no core: exit rather than linger.
process.exit(0);
