// Starting a core process in the background and finding the one a data folder belongs to.
// Used by the CLI (`kiln start`, `kiln dev`, `kiln doctor`).
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreStatus } from '@kiln/widget-sdk';
import { readRuntimeFile } from '../runtime-file.ts';

const START_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The status of the core recorded in this data folder, if it is up and answering. */
export async function runningCore(dataDir: string): Promise<CoreStatus | undefined> {
  const info = readRuntimeFile(dataDir);
  if (!info) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/status`, { signal: AbortSignal.timeout(2_000) });
    const status = (await res.json()) as CoreStatus;
    return status.name === 'Kiln' && status.pid === info.pid ? status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts `node <main> <args>` detached, logging to `<dataDir>/core.log`, and waits until it serves.
 * Returns its status, or undefined when it did not start in time.
 */
export async function launchCore(main: string, args: string[], dataDir: string): Promise<CoreStatus | undefined> {
  mkdirSync(dataDir, { recursive: true });
  const log = openSync(join(dataDir, 'core.log'), 'a');
  const child = spawn(process.execPath, [main, ...args], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await runningCore(dataDir);
    if (status && status.pid === child.pid) return status;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  return undefined;
}
