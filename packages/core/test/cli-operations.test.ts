import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CoreStatus } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type TestKiln } from '@kiln/testing';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** This checkout: the dev instance runs the core code from here. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the `kiln` CLI and returns its exit code and output, whatever the code. */
const kiln = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  new Promise<CliResult>((done) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, KILN_PORT: undefined, KILN_DATA_DIR: undefined, KILN_LOGIN: undefined, ...env } },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function restartedCore(core: TestKiln, pid: number): Promise<CoreStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await core.api<CoreStatus>('GET', '/api/status').catch(() => undefined);
    if (status && status.pid !== pid) return status;
    await sleep(100);
  }
  throw new Error('The core did not restart');
}

const target = (core: TestKiln) => ['--port', String(core.port), '--data-dir', core.dataDir];

test('kiln restart asks for Restart when idle, and the core restarts once nothing runs', async (t) => {
  const core = await startTestKiln(t);
  const before = await core.api<CoreStatus>('GET', '/api/status');

  const result = await kiln(['restart', ...target(core)]);
  const after = await restartedCore(core, before.pid);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /restart/i);
  assert.equal(after.port, before.port);
});

test('kiln restart and kiln stop refuse when run by an Agent, so a Session never restarts the live core', async (t) => {
  const core = await startTestKiln(t);
  const before = await core.api<CoreStatus>('GET', '/api/status');
  // Every process a Widget (and so an Agent) starts has these in its environment.
  const agentEnv = { KILN_WIDGET_ID: 'claude-code', KILN_WIDGET_TOKEN: 'secret' };

  const restart = await kiln(['restart', ...target(core)], agentEnv);
  const stop = await kiln(['stop', ...target(core)], agentEnv);
  await sleep(300);
  const after = await core.api<CoreStatus>('GET', '/api/status');

  assert.equal(restart.code, 1);
  assert.equal(stop.code, 1);
  assert.match(restart.stderr, /Agent/);
  assert.match(stop.stderr, /dev instance/);
  assert.equal(after.pid, before.pid, 'the core kept running');
  assert.equal(after.restartPending, undefined);
});

interface DevInstance {
  url: string;
  port: number;
  dataDir: string;
  pid: number;
  worktree: string;
}

test('kiln dev starts a core from a worktree on its own port and throwaway data folder, beside the live one', async (t) => {
  const live = await startTestKiln(t); // stands in for the live Kiln
  const agentEnv = { KILN_WIDGET_ID: 'claude-code', KILN_WIDGET_TOKEN: 'secret' };

  const started = await kiln(['dev', '--worktree', REPO_ROOT, '--json'], agentEnv);
  assert.equal(started.code, 0, started.stderr);
  const dev = JSON.parse(started.stdout) as DevInstance;
  t.after(() => kiln(['stop', '--data-dir', dev.dataDir]));
  const devStatus = (await (await fetch(`${dev.url}/api/status`)).json()) as CoreStatus;
  const liveStatus = await live.api<CoreStatus>('GET', '/api/status');
  const stopped = await kiln(['stop', '--data-dir', dev.dataDir], agentEnv);

  assert.equal(devStatus.instance, 'dev');
  assert.equal(devStatus.dataDir, dev.dataDir);
  assert.notEqual(dev.port, live.port);
  assert.ok(![8300, 8195].includes(dev.port));
  assert.notEqual(dev.dataDir, live.dataDir);
  assert.equal(liveStatus.instance, 'live');
  assert.equal(stopped.code, 0, `an Agent may stop its own dev instance: ${stopped.stderr}`);
  assert.equal(existsSync(dev.dataDir), false, 'the throwaway data folder is removed when the dev instance stops');
  assert.equal((await live.api<CoreStatus>('GET', '/api/status')).pid, liveStatus.pid, 'the live core is untouched');
});

test('kiln dev refuses a folder that is not a Kiln worktree', async (t) => {
  const folder = tempDir(t, 'kiln-not-a-worktree');

  const result = await kiln(['dev', '--worktree', folder]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /not a Kiln worktree/);
});
