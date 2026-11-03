// A stand-in for nvidia-smi in tests: `node fake-nvidia-smi.mjs <state.json> <nvidia-smi args...>`.
// It answers the two queries the GPU monitor makes from the state file, which the test rewrites to
// make the GPUs change. Any other arguments fail, so a Widget that tried to change GPU state would
// be caught. State: `{ gpus: [{ index, uuid, name, use, used, total }], apps: [{ uuid, pid, name, used }],
// fail?: "message" }` (fail: exit 9 with that message, as nvidia-smi does without a driver).
import { readFileSync, appendFileSync } from 'node:fs';

const [stateFile, ...args] = process.argv.slice(2);
appendFileSync(`${stateFile}.calls`, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
if (state.fail) {
  process.stdout.write(`${state.fail}\n`);
  process.exit(9);
}
const query = args.find((a) => a.startsWith('--query-'));
if (!query || !args.includes('--format=csv,noheader,nounits') || args.length !== 2) {
  process.stderr.write(`fake nvidia-smi: unexpected arguments ${args.join(' ')}\n`);
  process.exit(2);
}
const cell = (v) => (v === null || v === undefined ? '[N/A]' : String(v));
if (query.startsWith('--query-gpu=')) {
  for (const g of state.gpus ?? []) process.stdout.write(`${[g.index, g.uuid, g.name, cell(g.use), cell(g.used), cell(g.total)].join(', ')}\r\n`);
} else if (query.startsWith('--query-compute-apps=')) {
  for (const a of state.apps ?? []) process.stdout.write(`${[a.uuid, a.pid, a.name, cell(a.used)].join(', ')}\r\n`);
} else {
  process.exit(2);
}
