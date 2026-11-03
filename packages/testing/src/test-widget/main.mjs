// A tiny Widget for lifecycle tests. Plain JavaScript with no imports outside Node, so it runs
// from wherever Kiln installs it (a clone in the data folder has no node_modules).
//
// Config (KILN_WIDGET_CONFIG): `{ "crash": true }` exits with code 3 at once.
// Commands (through POST /api/test/widgets/:id/commands):
//   { type: 'test.call', method, path, body? }  calls the core with its own credential and appends
//                                               `{ method, path, status, body }` to <data dir>/calls.jsonl
//   { type: 'test.subscribe', types, lastEventId? }  opens GET /api/widget/events?types=...; appends
//                                               `{ types, status, body? }` to subscriptions.jsonl and
//                                               every event it then receives to events.jsonl
//   { type: 'test.crash' }                      exits with code 4
//   { type: 'test.env' }                        appends `{ names }` (its environment's variable names) to env.jsonl
//   { type: 'widget.action', ... }              (sent by the core for a panel button or page) appended
//                                               to actions.jsonl
// An `agents.json` beside this file (a list of Agent registrations) is registered as its Agents.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const api = env.KILN_API_URL;
const config = JSON.parse(env.KILN_WIDGET_CONFIG || '{}');
if (config.crash) process.exit(3);

const auth = { authorization: `Bearer ${env.KILN_WIDGET_TOKEN}` };
const call = (method, path, body) =>
  fetch(`${api}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const log = (file, value) => appendFileSync(join(env.KILN_WIDGET_DATA_DIR, file), `${JSON.stringify(value)}\n`);
const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

/** Calls `onData` with the data of each SSE message until the stream ends. */
async function readSse(body, onData) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) await onData(data);
      }
    }
  } catch {
    // The core went away.
  }
}

async function subscribe(command) {
  const headers = { ...auth, accept: 'text/event-stream' };
  if (command.lastEventId !== undefined) headers['last-event-id'] = String(command.lastEventId);
  const res = await fetch(`${api}/api/widget/events?types=${encodeURIComponent(command.types.join(','))}`, { headers });
  if (!res.ok) {
    log('subscriptions.jsonl', { types: command.types, status: res.status, body: parse(await res.text()) });
    return;
  }
  log('subscriptions.jsonl', { types: command.types, status: res.status });
  void readSse(res.body, (data) => log('events.jsonl', JSON.parse(data)));
}

async function handle(command) {
  if (command.type === 'widget.stop') process.exit(0);
  if (command.type === 'test.crash') process.exit(4);
  if (command.type === 'test.call') {
    const res = await call(command.method, command.path, command.body);
    log('calls.jsonl', { method: command.method, path: command.path, status: res.status, body: parse(await res.text()) });
  }
  if (command.type === 'test.subscribe') await subscribe(command);
  if (command.type === 'widget.action') log('actions.jsonl', command);
  if (command.type === 'test.env') log('env.jsonl', { names: Object.keys(env).sort() });
}

const agentsFile = new URL('./agents.json', import.meta.url);
const agents = existsSync(agentsFile) ? JSON.parse(readFileSync(agentsFile, 'utf8')) : [];
await call('POST', '/api/widget/register', { agents });
const stream = await fetch(`${api}/api/widget/commands`, { headers: auth });
await call('POST', '/api/widget/ready');
await readSse(stream.body, (data) => handle(JSON.parse(data)));
// No command stream means no core: exit rather than linger.
process.exit(0);
