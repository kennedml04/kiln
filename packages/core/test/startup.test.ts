import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec, execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from '@kiln/testing';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const kiln = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<CliResult>((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, KILN_PORT: undefined, KILN_DATA_DIR: undefined, KILN_LOGIN: undefined, ...env } },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

// Every test points the startup entry at a fake: a JSON file standing in for the per-user Run key
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Run), so no test registers anything on this PC.
function fakeRunKey(t: { after(fn: () => unknown): void }) {
  const file = join(tempDir(t, 'kiln-run-key'), 'run.json');
  writeFileSync(file, JSON.stringify({ OtherApp: '"C:\\Other\\app.exe" --background' }));
  return { file, entries: () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string> };
}

test('kiln startup on registers one per-user startup entry that starts Kiln, and off removes it', async (t) => {
  const runKey = fakeRunKey(t);
  const dataDir = tempDir(t, 'kiln-startup');
  const env = { KILN_STARTUP_ENTRY_FILE: runKey.file };

  const on = await kiln(['startup', 'on', '--port', '0', '--data-dir', dataDir], env);
  await kiln(['startup', 'on', '--port', '0', '--data-dir', dataDir], env);
  const afterOn = runKey.entries();
  const status = JSON.parse((await kiln(['startup', 'status', '--json'], env)).stdout) as { enabled: boolean; command?: string };
  let running: { running: boolean };
  try {
    // What Windows does at login: run the entry's command line.
    await promisify(exec)(afterOn.Kiln!, { windowsHide: true });
    running = JSON.parse((await kiln(['status', '--json', '--data-dir', dataDir], {})).stdout) as { running: boolean };
  } finally {
    // Stop it here, not in an after-hook: hooks run in order, and the data folder's removal comes first.
    await kiln(['stop', '--data-dir', dataDir], {});
  }
  const off = await kiln(['startup', 'off'], env);

  assert.equal(on.code, 0, on.stderr);
  assert.deepEqual(Object.keys(afterOn).sort(), ['Kiln', 'OtherApp'], 'exactly one Kiln entry, others untouched');
  assert.match(afterOn.Kiln!, / start /);
  // node.exe is a console program: run straight from the Run key it opens a terminal window at login.
  assert.match(afterOn.Kiln!, /^"[^"]*\\conhost\.exe" --headless /i, 'the entry runs Kiln without opening a window');
  assert.deepEqual(status, { enabled: true, command: afterOn.Kiln });
  assert.equal(running.running, true, 'the startup entry starts the core');
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(Object.keys(runKey.entries()), ['OtherApp']);
});
