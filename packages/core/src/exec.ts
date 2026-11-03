// Running another program, shared by every part of the core that does.
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';

/** `execFile` as a promise of `{ stdout, stderr }`; it rejects on a non-zero exit. */
export const run = promisify(execFile);

/**
 * Removes a folder and everything in it, retrying while another process (a git or Widget process
 * that is exiting) still holds it open. The promise form, because on Node 24 `rmSync` ignores
 * `maxRetries` and fails at once with EPERM on Windows.
 */
export const removeFolder = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
