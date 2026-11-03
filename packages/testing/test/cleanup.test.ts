import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tempDir } from '@kiln/testing';

const FIXTURE = fileURLToPath(new URL('./fixtures/failing-cleanup.fixture.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('a temp folder another process still holds for a moment is removed at cleanup', async (t) => {
  let dir = '';
  await t.test('holds its temp folder as it ends', (inner) => {
    dir = tempDir(inner, 'kiln-busy');
    // On Windows a process whose working folder is `dir` blocks deleting it (EPERM), as a git or
    // Widget process exiting with the core does. It lets go after a second.
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  });
  assert.equal(existsSync(dir), false);
});

test('a failing or stuck cleanup still closes the browser, so the test file ends with a clear failure', async () => {
  const { code, output, killed } = await new Promise<{ code: number | null; output: string; killed: boolean }>((done) => {
    const child = execFile(
      process.execPath,
      ['--test', '--test-reporter=spec', '--test-timeout=60000', FIXTURE],
      // Without NODE_TEST_CONTEXT, so the child runs the fixture as a file of its own.
      { cwd: ROOT, timeout: 90_000, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
      (error, stdout, stderr) =>
        done({ code: child.exitCode, output: stdout + stderr, killed: Boolean(error && 'killed' in error && error.killed) }),
    );
  });
  assert.equal(killed, false, `The fixture never ended:\n${output}`);
  assert.notEqual(code, 0, output);
  assert.match(output, /the test cleanup failed/);
  assert.match(output, /Cleanup "wait for nothing" did not finish within 500ms/);
});
