// The `kiln` command: start, stop, status, doctor, restart and dev for core processes.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreStatus, RestartPending } from '@kiln/widget-sdk';
import { resolveConfig, type CoreConfig } from './config.ts';
import { removeFolder } from './exec.ts';
import { doctorCommand } from './operations/doctor-cli.ts';
import { isAlive, launchCore, runningCore } from './operations/launch.ts';
import { readRuntimeFile, removeRuntimeFile } from './runtime-file.ts';
import { ENTRY_NAME, startupCommand, startupEntries } from './operations/startup-entry.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const CLI = fileURLToPath(import.meta.url);
const STOP_TIMEOUT_MS = 10_000;
/** Written into a dev instance's data folder; `kiln stop` removes such a folder once the core is down. */
const DEV_MARKER = 'dev-instance.json';
/** The live Kiln and the old board. A dev instance never takes either. */
const RESERVED_PORTS = [8300, 8195];

const USAGE = `Usage: kiln <command> [--port <n>] [--data-dir <path>] [--login local|tailscale] [--json]

Commands:
  start    Start the Kiln core in the background
  stop     Stop the running core (a dev instance's data folder is removed too)
  status   Show the port, data folder and uptime
  doctor   Check the port, data folder, git, Widgets, Agents and more; say how to fix each problem
  restart  Restart when idle: wait until no Session runs, then restart the core
  startup  on | off | status: start Kiln when you log in, through one per-user startup entry
           (on Windows the "Kiln" value in HKCU\\...\\CurrentVersion\\Run). "on" keeps the
           --port, --data-dir and --login given here.
  dev      Start a dev instance: a core from --worktree <path> (default: this folder), on a free
           port (or --port) with a throwaway data folder. Stop it with kiln stop --data-dir <folder>.

The port defaults to 8300 (or KILN_PORT); the data folder to %LOCALAPPDATA%\\Kiln (or KILN_DATA_DIR).
The login mode defaults to local: localhost only, and the person at the PC is Admin (or KILN_LOGIN).`;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const formatUptime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const parts = [[Math.floor(s / 86400), 'd'], [Math.floor(s / 3600) % 24, 'h'], [Math.floor(s / 60) % 60, 'm'], [s % 60, 's']] as const;
  return parts.filter(([n], i) => n > 0 || i === 3).map(([n, u]) => `${n}${u}`).join(' ');
};

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

async function start(config: CoreConfig): Promise<number> {
  const existing = await runningCore(config.dataDir);
  if (existing) {
    console.log(`Kiln is already running on port ${existing.port} (pid ${existing.pid}).`);
    return 0;
  }
  // The login mode is passed on only when it was given, so the one chosen in setup applies otherwise.
  const login = config.defaulted?.login ? [] : ['--login', config.login];
  const status = await launchCore(MAIN, ['--port', String(config.port), '--data-dir', config.dataDir, ...login], config.dataDir);
  if (!status) {
    console.error(`Kiln did not start. See ${join(config.dataDir, 'core.log')}.`);
    return 1;
  }
  console.log(`Kiln started on http://127.0.0.1:${status.port} (pid ${status.pid}).`);
  return 0;
}

/**
 * A dev instance: the core code of a worktree (a Ticket changing Kiln's own core), on a free port
 * and a fresh data folder in the temp dir, so its Session tests the change beside the live Kiln.
 */
async function dev(argv: string[], json: boolean): Promise<number> {
  const worktree = resolve(flagValue(argv, '--worktree') ?? process.cwd());
  const main = join(worktree, 'packages', 'core', 'src', 'main.ts');
  if (!existsSync(main)) {
    console.error(`${worktree} is not a Kiln worktree: it has no packages/core/src/main.ts. Pass --worktree <path to a Kiln checkout>.`);
    return 1;
  }
  const portText = flagValue(argv, '--port');
  const port = portText === undefined ? 0 : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || RESERVED_PORTS.includes(port)) {
    console.error(`A dev instance can't use port ${portText}: pick another, or leave --port out for a free one.`);
    return 1;
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'kiln-dev-'));
  writeFileSync(join(dataDir, DEV_MARKER), JSON.stringify({ worktree, createdAt: new Date().toISOString() }, null, 2));
  const status = await launchCore(main, ['--port', String(port), '--data-dir', dataDir, '--login', 'local', '--dev-instance'], dataDir);
  if (!status) {
    console.error(`The dev instance did not start. See ${join(dataDir, 'core.log')}.`);
    return 1;
  }
  const url = `http://127.0.0.1:${status.port}`;
  if (json) console.log(JSON.stringify({ url, port: status.port, dataDir, pid: status.pid, worktree }));
  else {
    console.log(`Dev instance from ${worktree} running on ${url} (pid ${status.pid}).`);
    console.log(`Data folder (throwaway): ${dataDir}`);
    console.log(`Stop it with: kiln stop --data-dir "${dataDir}"`);
  }
  return 0;
}

/** `kiln startup on|off|status`: the one per-user startup entry that runs `kiln start` at login. */
async function startup(argv: string[], config: CoreConfig, json: boolean): Promise<number> {
  const action = argv[0];
  const entries = startupEntries();
  if (!entries) {
    console.error('Start at login is only set up on Windows so far. Start Kiln with `kiln start` from your own login script.');
    return 1;
  }
  if (action === 'on') {
    // Only the flags given here: without them the entry starts the live Kiln with its defaults.
    const startArgs: string[] = [];
    if (argv.includes('--port')) startArgs.push('--port', String(config.port));
    if (argv.includes('--data-dir')) startArgs.push('--data-dir', config.dataDir);
    if (argv.includes('--login')) startArgs.push('--login', config.login);
    const command = startupCommand(CLI, startArgs);
    await entries.set(ENTRY_NAME, command);
    console.log(`Kiln now starts when you log in (${entries.where}, "${ENTRY_NAME}"):
  ${command}`);
    return 0;
  }
  if (action === 'off') {
    await entries.remove(ENTRY_NAME);
    console.log('Kiln no longer starts when you log in.');
    return 0;
  }
  if (action === 'status') {
    const command = await entries.get(ENTRY_NAME);
    if (json) console.log(JSON.stringify(command === undefined ? { enabled: false } : { enabled: true, command }));
    else console.log(command === undefined ? 'Kiln does not start at login.' : `Kiln starts at login with:
  ${command}`);
    return 0;
  }
  console.error('Usage: kiln startup on|off|status');
  return 1;
}

/**
 * Every process a Widget starts (and so every Agent's shell) has the Widget's id and token in its
 * environment. Agents never restart or stop the live core; a dev instance is theirs to stop.
 */
function refuseAgent(command: string, core: CoreStatus | undefined): boolean {
  const fromWidget = process.env.KILN_WIDGET_ID !== undefined || process.env.KILN_WIDGET_TOKEN !== undefined;
  if (!fromWidget || core?.instance === 'dev') return false;
  console.error(
    `kiln ${command} was run by an Agent (inside a Widget's process). Agents never restart or stop the live core: ` +
      'a person does that, with "Restart when idle" in the Shell or `kiln restart` in their own terminal. ' +
      'To test a core change, start a dev instance with `kiln dev --worktree <path>`.',
  );
  return true;
}

async function restart(config: CoreConfig): Promise<number> {
  const core = await runningCore(config.dataDir);
  if (refuseAgent('restart', core)) return 1;
  if (!core) {
    console.log('Kiln is not running. Start it with `kiln start`.');
    return 1;
  }
  const res = await fetch(`http://127.0.0.1:${core.port}/api/core/restart-when-idle`, { method: 'POST' });
  if (!res.ok) {
    console.error(`Kiln refused the restart: ${await res.text()}`);
    return 1;
  }
  const pending = (await res.json()) as RestartPending;
  console.log(
    pending.runningSessions === 0
      ? 'Kiln is restarting now: no Session is running.'
      : `Kiln will restart when idle: waiting for ${pending.runningSessions} running Session(s) to finish. No new Session starts meanwhile.`,
  );
  return 0;
}

async function stop(config: CoreConfig): Promise<number> {
  const info = readRuntimeFile(config.dataDir);
  const status = await runningCore(config.dataDir);
  if (refuseAgent('stop', status)) return 1;
  if (info && status) {
    await fetch(`http://127.0.0.1:${info.port}/api/core/stop`, { method: 'POST' }).catch(() => undefined);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (isAlive(info.pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(info.pid)) process.kill(info.pid);
  }
  if (info && !isAlive(info.pid)) removeRuntimeFile(config.dataDir, info.pid);
  const wasDev = existsSync(join(config.dataDir, DEV_MARKER));
  if (wasDev && !(info && isAlive(info.pid))) await removeFolder(config.dataDir);
  console.log(info && status ? (wasDev ? 'Dev instance stopped and its data folder removed.' : 'Kiln stopped.') : 'Kiln is not running.');
  return 0;
}

async function status(config: CoreConfig, json: boolean): Promise<number> {
  const core = await runningCore(config.dataDir);
  if (json) {
    const body = core
      ? { running: true, port: core.port, dataDir: core.dataDir, uptimeMs: core.uptimeMs, pid: core.pid }
      : { running: false, port: config.port, dataDir: config.dataDir };
    console.log(JSON.stringify(body));
  } else if (core) {
    console.log(`Kiln is running on http://127.0.0.1:${core.port} (pid ${core.pid})${core.instance === 'dev' ? ', a dev instance' : ''}`);
    console.log(`Data folder: ${core.dataDir}`);
    console.log(`Uptime: ${formatUptime(core.uptimeMs)}`);
    if (core.restartPending) console.log(`Restart when idle: waiting for ${core.restartPending.runningSessions} running Session(s).`);
  } else {
    console.log(`Kiln is not running (port ${config.port}, data folder ${config.dataDir}).`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  const config = resolveConfig(rest.filter((arg) => arg !== '--json'));
  switch (command) {
    case 'start':
      return start(config);
    case 'stop':
      return stop(config);
    case 'status':
      return status(config, json);
    case 'restart':
      return restart(config);
    case 'doctor':
      return doctorCommand(config, json);
    case 'dev':
      return dev(rest, json);
    case 'startup':
      return startup(rest, config, json);
    default:
      console.log(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
