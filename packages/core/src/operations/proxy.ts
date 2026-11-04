// Spots a reverse proxy (`tailscale serve`, or any local one) in front of Kiln. A proxy's requests
// reach Kiln from loopback, but the login adapter never takes a proxied request for the person at
// the PC: in Tailscale mode it is the tailnet user `tailscale serve` names, otherwise nobody (see
// login.ts). So an HTTPS `tailscale serve` in Tailscale mode is fine. What is left to report:
// a raw TCP forward (no headers, so its callers would be the local Admin), Funnel, and proxies whose
// callers Kiln can't name and so refuses.
import type { IncomingMessage } from 'node:http';
import type { LoginMode, TailscaleServe } from '@kiln/widget-sdk';
import { run } from '../exec.ts';
import { isLoopback, proxyHeader } from '../login.ts';
import type { DoctorCheck } from './doctor.ts';
const CLI_TIMEOUT_MS = 5_000;

export interface ProxyWatch {
  /** Call for every request: remembers a loopback request that carries proxy headers. */
  observe(req: IncomingMessage): void;
  /** What `tailscale serve` forwards to Kiln, if it does. */
  servedByTailscale(): Promise<TailscaleServe | undefined>;
  check: DoctorCheck;
}

export interface ProxyWatchOptions {
  port(): number;
  /** The `tailscale` command. Defaults to `KILN_TAILSCALE_CLI` or `tailscale`. A `.mjs`/`.js` file runs with Node (tests). */
  tailscaleCli?: string;
  /** The login mode the core runs in. */
  login?: LoginMode;
}

/** The parts of `tailscale serve status --json` (a ServeConfig) that say where traffic goes. */
interface ServeConfig {
  TCP?: Record<string, { TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  /** Serve sessions started in the foreground, each its own config. */
  Foreground?: Record<string, ServeConfig>;
  /** Tailscale Services, each with its own TCP and Web. */
  Services?: Record<string, ServeConfig>;
}

/** What in a ServeConfig points at this port, if anything. Funnel is looked up in the top-level config. */
function findServe(config: ServeConfig, pointsHere: (target: string) => boolean, funnel: ServeConfig['AllowFunnel']): TailscaleServe | undefined {
  const funnelOn = (key: (hostPort: string) => boolean) => Object.entries(funnel ?? {}).some(([hostPort, on]) => on && key(hostPort));
  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    for (const handler of Object.values(web.Handlers ?? {})) {
      if (handler.Proxy && pointsHere(handler.Proxy)) {
        return { target: handler.Proxy, kind: 'web', funnel: funnelOn((key) => key === hostPort) };
      }
    }
  }
  for (const [port, tcp] of Object.entries(config.TCP ?? {})) {
    if (tcp.TCPForward && pointsHere(tcp.TCPForward)) {
      return { target: tcp.TCPForward, kind: 'tcp', funnel: funnelOn((key) => key.endsWith(`:${port}`)) };
    }
  }
  for (const nested of [...Object.values(config.Foreground ?? {}), ...Object.values(config.Services ?? {})]) {
    const found = findServe(nested, pointsHere, { ...funnel, ...nested.AllowFunnel });
    if (found) return found;
  }
  return undefined;
}

/** What `tailscale serve status --json` says points at this port, if anything. */
async function tailscaleServeTarget(cli: string, port: number): Promise<TailscaleServe | undefined> {
  const [file, args] = /\.m?js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
  let stdout: string;
  try {
    ({ stdout } = await run(file, [...args, 'serve', 'status', '--json'], { timeout: CLI_TIMEOUT_MS, windowsHide: true }));
  } catch {
    return undefined; // No Tailscale, or it isn't running: nothing can be serving.
  }
  const local = new RegExp(`(?:https?(?:\\+insecure)?://|tcp://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}(?!\\d)`, 'i');
  let config: ServeConfig;
  try {
    config = JSON.parse(stdout) as ServeConfig;
  } catch {
    // A shape this code doesn't know: if it mentions Kiln's port, assume the worst (no caller named).
    const hit = local.exec(stdout)?.[0];
    return hit ? { target: hit, kind: 'tcp', funnel: false } : undefined;
  }
  if (!config || typeof config !== 'object') return undefined;
  return findServe(config, (target) => local.test(target), config.AllowFunnel);
}

export function createProxyWatch(options: ProxyWatchOptions): ProxyWatch {
  const cli = options.tailscaleCli ?? process.env.KILN_TAILSCALE_CLI ?? 'tailscale';
  const tailscaleMode = options.login === 'tailscale';
  /** The first proxied request whose caller Kiln can't name (refused), and the first it can. */
  let unnamed: { at: string; header: string } | undefined;
  let named: { at: string } | undefined;
  return {
    servedByTailscale: () => tailscaleServeTarget(cli, options.port()),
    observe(req) {
      if (!isLoopback(req.socket.remoteAddress)) return;
      const header = proxyHeader(req);
      if (!header) return;
      const at = new Date().toISOString();
      if (tailscaleMode && req.headers['tailscale-user-login']) named ??= { at };
      else unnamed ??= { at, header };
    },
    check: {
      id: 'proxy',
      name: 'Reverse proxy',
      async run() {
        const served = await tailscaleServeTarget(cli, options.port());
        if (served?.kind === 'tcp') {
          return {
            status: 'fail',
            detail:
              `tailscale serve forwards raw TCP to Kiln (${served.target}). Those requests arrive from this PC and name no caller, ` +
              'so every remote caller would be the local Admin.',
            fix: `Serve Kiln over HTTPS instead (\`tailscale serve --bg ${options.port()}\`), which names each caller, or turn the TCP forward off (\`tailscale serve reset\`).`,
          };
        }
        if (served && !tailscaleMode) {
          return {
            status: 'warn',
            detail: `tailscale serve forwards to Kiln (${served.target}), but Kiln runs in Local login mode, so callers through it get no access.`,
            fix: 'Start Kiln in Tailscale login mode (`kiln start --login tailscale`), or turn the serve off (`tailscale serve reset`).',
          };
        }
        if (served?.funnel) {
          return {
            status: 'warn',
            detail: `Funnel is on for the tailscale serve entry that forwards to Kiln (${served.target}). Callers from the internet reach Kiln, but Kiln can't name them, so they get no access.`,
            fix: 'Turn Funnel off for that entry (for example `tailscale funnel --https=443 off`), so only your tailnet reaches Kiln.',
          };
        }
        if (unnamed) {
          return {
            status: 'warn',
            detail:
              `A request reached Kiln through a proxy on this PC (its "${unnamed.header}" header, at ${unnamed.at}) without a caller Kiln can name, ` +
              'so it got no access.',
            fix: tailscaleMode
              ? 'Use `tailscale serve`, which names each tailnet caller, or reach Kiln at its tailnet address directly.'
              : 'Kiln in Local login mode answers only the person at this PC. For remote use, start it in Tailscale login mode (`kiln start --login tailscale`).',
          };
        }
        if (served) {
          return { status: 'pass', detail: `tailscale serve forwards to Kiln (${served.target}) and names each tailnet caller, so they keep their own role.` };
        }
        if (named) return { status: 'pass', detail: 'A proxy on this PC forwards to Kiln with each caller\'s Tailscale login, so they keep their own role.' };
        return { status: 'pass', detail: 'No reverse proxy found in front of Kiln.' };
      },
    },
  };
}
