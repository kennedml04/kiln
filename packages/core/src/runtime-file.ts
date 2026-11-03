import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written to the data folder while a core runs, so the CLI can find it. */
export interface RuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
}

const FILE = 'core.json';

export const runtimeFilePath = (dataDir: string) => join(dataDir, FILE);

export function writeRuntimeFile(dataDir: string, info: RuntimeInfo): void {
  writeFileSync(runtimeFilePath(dataDir), JSON.stringify(info, null, 2));
}

export function readRuntimeFile(dataDir: string): RuntimeInfo | undefined {
  try {
    return JSON.parse(readFileSync(runtimeFilePath(dataDir), 'utf8')) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

export function removeRuntimeFile(dataDir: string, pid: number): void {
  if (readRuntimeFile(dataDir)?.pid === pid) rmSync(runtimeFilePath(dataDir), { force: true });
}
