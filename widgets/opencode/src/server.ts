// One `opencode serve` process and its HTTP API (OpenCode 1.x). All of OpenCode's wire format the
// Widget relies on is here and in session.ts's event handling; OpenCode 2.x reshaped its server API
// (`/api/...`), so a 2.x server is refused with a clear message rather than half driven.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, any>;
}

export interface OpenCodeServer {
  url: string;
  version: string;
  /** Calls the server API; resolves with the parsed body (undefined for an empty one). Throws on a non-2xx status. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Follows the server's event stream until it ends or the server is closed. */
  follow(onEvent: (event: OpenCodeEvent) => void): Promise<void>;
  close(): void;
}

export class OpenCodeUnsupported extends Error {}

/** The major versions whose server API this Widget speaks. */
const SUPPORTED_MAJOR = 1;

/** Turns a configured command into what to spawn: "node" first means this Node. */
function resolveCommand(command: string[]): { file: string; args: string[]; shell: boolean } {
  const [tool = 'opencode', ...args] = command;
  if (tool === 'node') return { file: process.execPath, args, shell: false };
  // On Windows a global npm install is `opencode.cmd`, which only a shell can run.
  return { file: tool, args, shell: process.platform === 'win32' && !/\.(exe|com)$/i.test(tool) };
}

const quote = (arg: string) => (/^[\w./:=@\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

/** Ends the server; through a shell on Windows, the whole process tree (and before returning). */
function kill(child: ChildProcess, shell: boolean) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (shell && process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  } else child.kill();
}

export interface StartOptions {
  command: string[];
  /** Where the server runs: the Session's worktree. */
  cwd: string;
  /** The OpenCode config for this Session (OPENCODE_CONFIG_CONTENT). */
  config: unknown;
  /** How long to wait for the server to listen. Default 60 s. */
  timeoutMs?: number;
}

/** Starts `opencode serve` on a free local port with its own password, and checks its version. */
export async function startServer(options: StartOptions): Promise<OpenCodeServer> {
  const password = randomBytes(18).toString('base64url');
  const { file, args, shell } = resolveCommand(options.command);
  const all = [...args, 'serve', '--port', '0', '--hostname', '127.0.0.1'];
  const child = spawn(shell ? [file, ...all].map(quote).join(' ') : file, shell ? [] : all, {
    cwd: options.cwd,
    shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config), OPENCODE_SERVER_PASSWORD: password },
  });
  let output = '';
  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => {
      kill(child, shell);
      fail(new Error(`opencode serve did not start listening within ${options.timeoutMs ?? 60_000} ms. Output: ${output.slice(-2000)}`));
    }, options.timeoutMs ?? 60_000);
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8000);
      const m = /listening on (https?:\/\/[^\s]+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        done(m[1]!.replace(/\/$/, ''));
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(new Error(`Could not run ${options.command.join(' ')}: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`opencode serve exited (${code}) before listening. Output: ${output.slice(-2000)}`));
    });
  });
  // Keep draining its output so it never blocks on a full pipe.
  child.stdout!.resume();
  child.stderr!.resume();

  const controller = new AbortController();
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-opencode-directory': options.cwd,
  };
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${path}${sep}directory=${encodeURIComponent(options.cwd)}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode ${method} ${path} -> ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };

  let version = 'unknown';
  try {
    const health = await request<{ healthy?: boolean; version?: string }>('GET', '/global/health');
    version = health?.version ?? 'unknown';
  } catch (err) {
    kill(child, shell);
    throw new OpenCodeUnsupported(
      `This OpenCode server has no 1.x health check (${String(err)}). The OpenCode Widget drives OpenCode ${SUPPORTED_MAJOR}.x's server API.`,
    );
  }
  const major = Number(version.split('.')[0]);
  if (major !== SUPPORTED_MAJOR) {
    kill(child, shell);
    throw new OpenCodeUnsupported(
      `OpenCode ${version} is not supported: the OpenCode Widget drives OpenCode ${SUPPORTED_MAJOR}.x's server API (opencode serve). Point the Widget's "opencode" setting at an OpenCode ${SUPPORTED_MAJOR}.x install.`,
    );
  }

  return {
    url,
    version,
    request,
    async follow(onEvent) {
      const res = await fetch(`${url}/event?directory=${encodeURIComponent(options.cwd)}`, {
        headers: { ...headers, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`OpenCode event stream failed: ${res.status}`);
      await readSse(res.body, (data) => {
        let event: OpenCodeEvent;
        try {
          event = JSON.parse(data) as OpenCodeEvent;
        } catch {
          return;
        }
        // The global stream wraps events: { directory, payload }.
        const payload = (event as unknown as { payload?: OpenCodeEvent }).payload;
        onEvent(payload?.type ? payload : event);
      });
    },
    close() {
      controller.abort();
      kill(child, shell);
    },
  };
}

/** Calls `onData` with the data of each SSE message until the stream ends. */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (data) onData(data);
      }
    }
  } catch {
    // The stream was closed.
  }
}
