// `kiln doctor`, the CLI's half: checks that work with or without a running core (is it up, the
// port, the data folder, git), then the running core's own checks from GET /api/doctor.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreStatus, DoctorCheckResult, DoctorReport } from '@kiln/widget-sdk';
import type { CoreConfig } from '../config.ts';
import { run } from '../exec.ts';
import { runningCore } from './launch.ts';

const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });

function coreCheck(config: CoreConfig, core: CoreStatus | undefined): DoctorCheckResult {
  const base = { id: 'core', name: 'Kiln core' };
  if (core) return { ...base, status: 'pass', detail: `Kiln is running on http://127.0.0.1:${core.port} (pid ${core.pid}).` };
  return {
    ...base,
    status: 'fail',
    detail: `Kiln is not running for the data folder ${config.dataDir}, so the Widget, Agent and proxy checks were skipped.`,
    fix: 'Start it with `kiln start` (with the same --port and --data-dir), then run `kiln doctor` again.',
  };
}

async function portCheck(config: CoreConfig, core: CoreStatus | undefined): Promise<DoctorCheckResult> {
  const base = { id: 'port', name: 'Port' };
  if (core) return { ...base, status: 'pass', detail: `Kiln is serving on port ${core.port}.` };
  if (await portFree(config.port)) return { ...base, status: 'pass', detail: `Port ${config.port} is free for Kiln.` };
  return {
    ...base,
    status: 'fail',
    detail: `Port ${config.port} is in use by another program, so Kiln can't start on it.`,
    fix: `Close the program using port ${config.port}, or start Kiln on another port with --port <n> (or KILN_PORT).`,
  };
}

function dataDirCheck(config: CoreConfig): DoctorCheckResult {
  const base = { id: 'data-dir', name: 'Data folder' };
  if (!existsSync(config.dataDir)) {
    return { ...base, status: 'pass', detail: `${config.dataDir} doesn't exist yet; Kiln creates it when it first starts.` };
  }
  const probe = join(config.dataDir, `.doctor-${process.pid}`);
  try {
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return { ...base, status: 'pass', detail: `${config.dataDir} is writable.` };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      detail: `Kiln can't write to ${config.dataDir}: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`,
      fix: 'Make the folder writable for your user (or free the disk), or choose another with --data-dir <path> (or KILN_DATA_DIR).',
    };
  }
}

/** The git identity a Session's own commits would use, outside any repo: `user.name` and `user.email`. */
const gitIdentity = async (key: 'user.name' | 'user.email') => {
  try {
    const { stdout } = await run('git', ['config', '--get', key], { cwd: tmpdir(), timeout: 10_000, windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

async function gitCheck(): Promise<DoctorCheckResult> {
  const base = { id: 'git', name: 'Git' };
  try {
    const { stdout } = await run('git', ['--version'], { timeout: 10_000, windowsHide: true });
    // Kiln commits as itself, but an Agent commits in its worktree with the machine's identity.
    const keys = ['user.name', 'user.email'] as const;
    const values = await Promise.all(keys.map(gitIdentity));
    const unset = keys.filter((_, i) => values[i] === undefined);
    if (unset.length) {
      return {
        ...base,
        status: 'warn',
        detail: `${stdout.trim()}, but git has no ${unset.join(' or ')}, so an Agent's commit in its Session worktree fails.`,
        fix: 'Set your git identity once: `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.',
      };
    }
    return { ...base, status: 'pass', detail: stdout.trim() };
  } catch {
    return {
      ...base,
      status: 'fail',
      detail: 'git was not found, and Kiln needs it for Projects, worktrees and Widget installs.',
      fix: 'Install Git (https://git-scm.com/downloads), make sure `git` is on the PATH, then open a new terminal.',
    };
  }
}

async function coreChecks(core: CoreStatus): Promise<DoctorCheckResult[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${core.port}/api/doctor`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return ((await res.json()) as DoctorReport).checks;
  } catch (err) {
    return [
      {
        id: 'core-checks',
        name: 'Core checks',
        status: 'fail',
        detail: `The running core did not answer its checks: ${String(err)}`,
        fix: 'Look at core.log in the data folder; restart Kiln with "Restart when idle" if it is stuck.',
      },
    ];
  }
}

export async function doctorChecks(config: CoreConfig): Promise<DoctorCheckResult[]> {
  const core = await runningCore(config.dataDir);
  const local = [coreCheck(config, core), await portCheck(config, core), dataDirCheck(config), await gitCheck()];
  return core ? [...local, ...(await coreChecks(core))] : local;
}

const LABEL: Record<DoctorCheckResult['status'], string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', 'not-configured': 'N/A ' };

/** Prints the checks (JSON with --json) and returns the exit code: 1 when any check failed. */
export async function doctorCommand(config: CoreConfig, json: boolean): Promise<number> {
  const checks = await doctorChecks(config);
  if (json) console.log(JSON.stringify({ checks }));
  else {
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const check of checks) {
      console.log(`${LABEL[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`);
      if (check.fix) console.log(`${' '.repeat(width + 8)}Fix: ${check.fix}`);
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    console.log(failed ? `\n${failed} problem(s) found.` : '\nNo problems found.');
  }
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
