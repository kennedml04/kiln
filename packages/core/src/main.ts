// The core process. Started by `kiln start` (detached) or by the test harness.
// Prints one JSON line `{"kiln":"ready","port":N,...}` on stdout once it is serving.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from './config.ts';
import { readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from './runtime-file.ts';
import { startCore } from './server.ts';

const REPLACEMENT_TIMEOUT_MS = 15_000;
const argv = process.argv.slice(2);
const config = resolveConfig(argv);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await core.stop();
  removeRuntimeFile(config.dataDir, process.pid);
  process.exit(0);
};

/**
 * Restart when idle: stop this core (its port and data folder are then free), start a fresh core
 * process with the same arguments on the same port, wait until it has written its runtime file,
 * then exit. The new process runs the code on disk now, so a core update takes effect.
 */
const restart = async () => {
  if (stopping) return;
  stopping = true;
  const { port } = core.status();
  await core.stop();
  removeRuntimeFile(config.dataDir, process.pid);
  const args = [...argv];
  const portAt = args.indexOf('--port');
  if (portAt === -1) args.push('--port', String(port));
  else args[portAt + 1] = String(port);
  mkdirSync(config.dataDir, { recursive: true });
  const log = openSync(join(config.dataDir, 'core.log'), 'a');
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...args], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  const deadline = Date.now() + REPLACEMENT_TIMEOUT_MS;
  while (Date.now() < deadline && readRuntimeFile(config.dataDir)?.pid !== child.pid) {
    if (child.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const started = readRuntimeFile(config.dataDir)?.pid === child.pid;
  if (!started) console.error(`Kiln could not restart: the new core did not start. See ${join(config.dataDir, 'core.log')}.`);
  process.exit(started ? 0 : 1);
};

const core = await startCore({
  ...config,
  onStopRequested: () => void shutdown(),
  onRestartRequested: () => void restart(),
});
const { port, startedAt, dataDir } = core.status();
writeRuntimeFile(dataDir, { pid: process.pid, port, startedAt });
process.stdout.write(`${JSON.stringify({ kiln: 'ready', port, dataDir, pid: process.pid })}\n`);

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
