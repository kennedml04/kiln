// Fake Bambu Studio and KiCad CLIs, made by the tests in a temp folder. Each is a small Node
// script behind a launcher of the tool's own name (`<name>.cmd` on Windows, an executable shell
// script elsewhere), so the module checks find and run it exactly as they would the real tool.
// Every call is appended to `calls.log` in the fake's folder, one JSON line of arguments each.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, type Cleanup } from '@kiln/testing';

/** What a fake model or board file holds: the fake reads it to decide what the tool reports. */
export interface FakeSliceInput {
  /** Messages the slicer warns about on plate 1. */
  warnings?: string[];
  /** A slicing error: a non-zero return code with this message. */
  error?: string;
}

export interface FakeDrcInput {
  violations?: { severity: 'error' | 'warning'; type: string; description: string }[];
  /** How many unconnected items (errors) the board has. */
  unconnected?: number;
}

/** Bambu Studio CLI: `--slice 0 --outputdir <dir> <file>` writes `<dir>/result.json`. */
const BAMBU = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(join(import.meta.dirname, 'calls.log'), JSON.stringify(args) + '\\n');
const out = args[args.indexOf('--outputdir') + 1];
const input = JSON.parse(readFileSync(args.at(-1), 'utf8'));
const code = input.error ? -100 : 0;
const result = {
  error_string: input.error ?? 'Success.',
  return_code: code,
  sliced_plates: [{ id: 1, warning_message: (input.warnings ?? []).map((msg) => ({ level: 1, msg })) }],
};
writeFileSync(join(out, 'result.json'), JSON.stringify(result));
process.exit(code === 0 ? 0 : 1);
`;

/** kicad-cli: `pcb drc --format json --severity-all --output <report> <board>` writes the JSON report. */
const KICAD = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(join(import.meta.dirname, 'calls.log'), JSON.stringify(args) + '\\n');
const out = args[args.indexOf('--output') + 1];
const input = JSON.parse(readFileSync(args.at(-1), 'utf8'));
const unconnected = Array.from({ length: input.unconnected ?? 0 }, (_, i) => ({
  type: 'unconnected_items', severity: 'error', description: 'Missing connection between items', items: [{ description: 'Pad ' + (i + 1) }],
}));
const report = { source: args.at(-1), violations: input.violations ?? [], unconnected_items: unconnected, schematic_parity: [] };
writeFileSync(out, JSON.stringify(report));
`;

export interface FakeTool {
  /** The folder holding the launcher: put it on PATH, or use `path`. */
  dir: string;
  /** The launcher's full path, as the tool path Setting would hold it. */
  path: string;
  /** The arguments of each call so far. */
  calls(): string[][];
}

function fakeTool(t: Cleanup, name: string, script: string): FakeTool {
  const dir = tempDir(t, `kiln-fake-${name}`);
  writeFileSync(join(dir, 'fake.mjs'), script);
  let path: string;
  if (process.platform === 'win32') {
    path = join(dir, `${name}.cmd`);
    writeFileSync(path, `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
  } else {
    path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`);
    chmodSync(path, 0o755);
  }
  const log = join(dir, 'calls.log');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  return { dir, path, calls };
}

export const fakeBambuStudio = (t: Cleanup) => fakeTool(t, 'bambu-studio', BAMBU);
export const fakeKicadCli = (t: Cleanup) => fakeTool(t, 'kicad-cli', KICAD);
