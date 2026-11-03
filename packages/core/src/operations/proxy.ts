// Spots a reverse proxy (`tailscale serve`, or any local one) in front of Kiln. A proxy's requests
// reach Kiln from loopback, and Kiln treats loopback as the local person, who is Admin: so every
// caller behind the proxy would be the local Admin. `kiln doctor` fails while that is the case.
import type { IncomingMessage } from 'node:http';
import { TAILSCALE_SERVE_WARNING, type LoginMode } from '@kiln/widget-sdk';
import { run } from '../exec.ts';
import type { DoctorCheck } from './doctor.ts';
const CLI_TIMEOUT_MS = 5_000;

/** Headers proxies add. Tailscale serve adds the Tailscale-User-* ones. */
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'tailscale-user-login'];

const isLoopback = (address: string | undefined) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export interface ProxyWatch {
  /** Call for every request: remembers a loopback request that carries proxy headers. */
  observe(req: IncomingMessage): void;
  /** What `tailscale serve` forwards to Kiln, if it does (the setup wizard warns about it). */
  servedByTailscale(): Promise<string | undefined>;
  check: DoctorCheck;
}

export interface ProxyWatchOptions {
  port(): number;
  /** The `tailscale` command. Defaults to `KILN_TAILSCALE_CLI` or `tailscale`. A `.mjs`/`.js` file runs with Node (tests). */
  tailscaleCli?: string;
  /** The login mode the core runs in. In Tailscale mode a passing check repeats the warning. */
  login?: LoginMode;
}

/** What `tailscale serve status --json` says points at this port, if anything. */
async function tailscaleServeTarget(cli: string, port: number): Promise<string | undefined> {
  const [file, args] = /\.m?js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
  let stdout: string;
  try {
    ({ stdout } = await run(file, [...args, 'serve', 'status', '--json'], { timeout: CLI_TIMEOUT_MS, windowsHide: true }));
  } catch {
    return undefined; // No Tailscale, or it isn't running: nothing can be serving.
  }
  const local = new RegExp(`(?:https?://|tcp://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?!\\d)`, 'i');
  return local.exec(stdout)?.[0];
}

export function createProxyWatch(options: ProxyWatchOptions): ProxyWatch {
  const cli = options.tailscaleCli ?? process.env.KILN_TAILSCALE_CLI ?? 'tailscale';
  let seen: { at: string; header: string } | undefined;
  return {
    servedByTailscale: () => tailscaleServeTarget(cli, options.port()),
    observe(req) {
      if (seen || !isLoopback(req.socket.remoteAddress)) return;
      const header = PROXY_HEADERS.find((name) => req.headers[name] !== undefined);
      if (header) seen = { at: new Date().toISOString(), header };
    },
    check: {
      id: 'proxy',
      name: 'Reverse proxy',
      async run() {
        const port = options.port();
        const fix =
          'Take the proxy away (for Tailscale: `tailscale serve reset`, or turn off just the Kiln entry) and use ' +
          "Kiln's Tailscale login mode instead (`kiln start --login tailscale`): it serves the tailnet itself and knows who each caller is.";
        const served = await tailscaleServeTarget(cli, port);
        if (served) {
          return {
            status: 'fail',
            detail: `tailscale serve forwards to Kiln (${served}). Its requests arrive from this PC, so every remote caller would be the local Admin.`,
            fix,
          };
        }
        if (seen) {
          return {
            status: 'fail',
            detail: `A request reached Kiln from this PC with a proxy's "${seen.header}" header (at ${seen.at}). Something forwards requests to Kiln, and Kiln treats every one of them as the local Admin.`,
            fix,
          };
        }
        const detail = 'No reverse proxy found in front of Kiln.';
        return { status: 'pass', detail: options.login === 'tailscale' ? `${detail} ${TAILSCALE_SERVE_WARNING}` : detail };
      },
    },
  };
}
