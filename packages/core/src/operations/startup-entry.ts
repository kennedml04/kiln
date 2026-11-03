// Start at login: one per-user startup entry that runs `kiln start`. No tray, watchdog or recovery
// process: the entry starts the core and the core supervises its Widgets itself (ADR 0010).
//
// On Windows the entry is the value "Kiln" under the per-user Run key, written with reg.exe:
//   reg add    HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Kiln /t REG_SZ /d "<command>" /f
//   reg query  HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Kiln
//   reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Kiln /f
// The OS call sits behind StartupEntries. With KILN_STARTUP_ENTRY_FILE set, a JSON file
// (`{ "<name>": "<command>" }`) stands in for the Run key, so tests never register anything.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { run } from '../exec.ts';

export const ENTRY_NAME = 'Kiln';
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** The per-user startup entries, by name. Kiln only ever touches its own (ENTRY_NAME). */
export interface StartupEntries {
  /** Where the entries live, for messages. */
  where: string;
  get(name: string): Promise<string | undefined>;
  set(name: string, command: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The Windows per-user Run key, through reg.exe. */
export function windowsRunKey(): StartupEntries {
  const reg = (...args: string[]) => run('reg', args, { windowsHide: true, timeout: 10_000 });
  return {
    where: RUN_KEY,
    async get(name) {
      try {
        const { stdout } = await reg('query', RUN_KEY, '/v', name);
        const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith(`${name} `));
        return line?.replace(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+`), '').trim();
      } catch {
        return undefined; // reg query exits 1 when the value doesn't exist.
      }
    },
    async set(name, command) {
      await reg('add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', command, '/f');
    },
    async remove(name) {
      if ((await this.get(name)) === undefined) return;
      await reg('delete', RUN_KEY, '/v', name, '/f');
    },
  };
}

/** A JSON file standing in for the Run key (tests). */
export function fileEntries(file: string): StartupEntries {
  const read = (): Record<string, string> => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {});
  const write = (entries: Record<string, string>) => writeFileSync(file, JSON.stringify(entries, null, 2));
  return {
    where: file,
    get: async (name) => read()[name],
    async set(name, command) {
      write({ ...read(), [name]: command });
    },
    async remove(name) {
      const { [name]: _gone, ...rest } = read();
      write(rest);
    },
  };
}

/** The startup entries for this user: the fake file when KILN_STARTUP_ENTRY_FILE is set, else the OS's. */
export function startupEntries(env: NodeJS.ProcessEnv = process.env): StartupEntries | undefined {
  if (env.KILN_STARTUP_ENTRY_FILE) return fileEntries(env.KILN_STARTUP_ENTRY_FILE);
  return process.platform === 'win32' ? windowsRunKey() : undefined;
}

const quote = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);

/**
 * The command line the entry runs: Node, the kiln CLI, `start`, and the flags given, inside a
 * headless console host. node.exe is a console program, so run straight from the Run key it opens
 * a terminal window at login (Windows Terminal ignores hidden-window flags). `conhost --headless`
 * gives it a console with no window; `kiln start` then starts the core detached and exits.
 */
export const startupCommand = (cli: string, startArgs: string[]) => {
  const conhost = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\conhost.exe`;
  const kiln = [process.execPath, cli, 'start', ...startArgs].map((arg, i) => (i < 2 ? `"${arg}"` : quote(arg))).join(' ');
  return `"${conhost}" --headless ${kiln}`;
};
