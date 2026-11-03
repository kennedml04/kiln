// Login adapters: who is on the other end of a request.
// Local mode binds 127.0.0.1 only and the person at the PC is Admin.
// Tailscale mode also binds the Tailscale interface and asks the local Tailscale daemon who each peer is.
import type { IncomingMessage } from 'node:http';
import type { LoginMode } from '@kiln/widget-sdk';
import { run } from './exec.ts';

/** In test mode only, Tailscale mode treats a loopback request carrying this header as that tailnet user. */
export const TEST_PEER_HEADER = 'x-kiln-test-peer';

const WHOIS_CACHE_MS = 60_000;
const CLI_TIMEOUT_MS = 5_000;

export interface Peer {
  id: string;
  name?: string;
}

/** `local`: the person at the PC. A Peer: a tailnet user. `undefined`: nobody Kiln can identify. */
export type Identity = 'local' | Peer | undefined;

export interface LoginAdapter {
  mode: LoginMode;
  /** Addresses to serve on besides 127.0.0.1. */
  bindAddresses(): Promise<string[]>;
  identify(req: IncomingMessage): Promise<Identity>;
  /**
   * Whether a request's Host name is one Kiln answers to. Refusing other names stops DNS
   * rebinding: a hostile page whose domain resolves to 127.0.0.1 is same-origin to the browser.
   */
  acceptsHost(hostname: string): boolean;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The host name of a Host header, lower case, without the port. */
export function hostName(header: string | undefined): string {
  if (!header) return '';
  const host = header.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.replace(/:\d+$/, '');
}

const isLoopback = (address: string | undefined) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export interface LoginOptions {
  mode: LoginMode;
  testMode: boolean;
  /** The `tailscale` command. Defaults to `KILN_TAILSCALE_CLI` or `tailscale` on the PATH. */
  tailscaleCli?: string;
}

export function createLoginAdapter(options: LoginOptions): LoginAdapter {
  if (options.mode === 'local') {
    return {
      mode: 'local',
      bindAddresses: async () => [],
      identify: async (req) => (isLoopback(req.socket.remoteAddress) ? 'local' : undefined),
      acceptsHost: (hostname) => LOOPBACK_NAMES.has(hostname),
    };
  }
  return createTailscaleAdapter(options);
}

interface WhoIs {
  UserProfile?: { LoginName?: string; DisplayName?: string };
}

function createTailscaleAdapter(options: LoginOptions): LoginAdapter {
  const cli = options.tailscaleCli ?? process.env.KILN_TAILSCALE_CLI ?? 'tailscale';
  const cache = new Map<string, { peer: Peer | undefined; until: number }>();

  const whois = async (address: string): Promise<Peer | undefined> => {
    const hit = cache.get(address);
    if (hit && hit.until > Date.now()) return hit.peer;
    let peer: Peer | undefined;
    try {
      const { stdout } = await run(cli, ['whois', '--json', address], { timeout: CLI_TIMEOUT_MS, windowsHide: true });
      const profile = (JSON.parse(stdout) as WhoIs).UserProfile;
      if (profile?.LoginName) peer = { id: profile.LoginName, ...(profile.DisplayName ? { name: profile.DisplayName } : {}) };
    } catch {
      peer = undefined;
    }
    cache.set(address, { peer, until: Date.now() + WHOIS_CACHE_MS });
    return peer;
  };

  const tailnetAddresses = new Set<string>();

  return {
    mode: 'tailscale',
    async bindAddresses() {
      if (options.testMode) return [];
      const { stdout } = await run(cli, ['ip'], { timeout: CLI_TIMEOUT_MS, windowsHide: true });
      const addresses = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const address of addresses) tailnetAddresses.add(address.includes(':') ? `[${address}]` : address);
      return addresses;
    },
    // Loopback, Kiln's own tailnet addresses, MagicDNS names (*.ts.net) and bare machine names.
    acceptsHost: (hostname) =>
      LOOPBACK_NAMES.has(hostname) ||
      tailnetAddresses.has(hostname) ||
      hostname.endsWith('.ts.net') ||
      /^[a-z0-9-]+$/.test(hostname),
    async identify(req) {
      const remote = req.socket.remoteAddress;
      if (isLoopback(remote)) {
        const testPeer = options.testMode ? req.headers[TEST_PEER_HEADER] : undefined;
        return typeof testPeer === 'string' && testPeer ? { id: testPeer } : 'local';
      }
      if (!remote) return undefined;
      return whois(remote.replace(/^::ffff:/, ''));
    },
  };
}
