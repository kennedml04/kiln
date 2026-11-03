import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from '@kiln/testing';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface StatusJson {
  running: boolean;
  port: number;
  dataDir: string;
  uptimeMs?: number;
}

const kiln = async (env: NodeJS.ProcessEnv, ...args: string[]) => {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
    env: { ...process.env, KILN_PORT: undefined, KILN_DATA_DIR: undefined, ...env },
  });
  return stdout;
};

test('kiln status defaults to port 8300 and the Kiln folder in LOCALAPPDATA', async (t) => {
  const fakeLocalAppData = tempDir(t, 'kiln-localappdata');

  const status = JSON.parse(await kiln({ LOCALAPPDATA: fakeLocalAppData }, 'status', '--json')) as StatusJson;

  assert.deepEqual(status, { running: false, port: 8300, dataDir: join(fakeLocalAppData, 'Kiln') });
});

test('kiln start, status and stop control one core on a chosen port and data folder', async (t) => {
  const dataDir = tempDir(t, 'kiln-cli');
  const env = { KILN_DATA_DIR: dataDir };
  t.after(() => kiln(env, 'stop').catch(() => undefined));

  await kiln(env, 'start', '--port', '0');
  const running = JSON.parse(await kiln(env, 'status', '--json')) as StatusJson;
  await kiln(env, 'start', '--port', '0');
  const afterSecondStart = JSON.parse(await kiln(env, 'status', '--json')) as StatusJson;
  await kiln(env, 'stop');
  const stopped = JSON.parse(await kiln(env, 'status', '--json')) as StatusJson;

  assert.equal(running.running, true);
  assert.equal(running.dataDir, dataDir);
  assert.ok(running.port > 0 && running.port !== 8300);
  assert.ok(typeof running.uptimeMs === 'number');
  assert.equal(afterSecondStart.port, running.port, 'a second start must not launch another core');
  assert.equal(stopped.running, false);
});
