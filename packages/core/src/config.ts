import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LoginMode } from '@kiln/widget-sdk';

export const DEFAULT_PORT = 8300;

export interface CoreConfig {
  /** 0 means "pick a free port"; the core reports the port it got. */
  port: number;
  dataDir: string;
  /** Enables test-only controls such as `POST /api/test/echo`. Never set on a live core. */
  testMode: boolean;
  /** `local` (default): localhost only, the local person is Admin. `tailscale`: also the tailnet. */
  login: LoginMode;
  /** The first wait before restarting a crashed Widget; each further crash doubles it. Default 1000. */
  widgetRestartMs?: number;
  /** A dev instance (`kiln dev`): a throwaway core started from a worktree. Reported in GET /api/status. */
  devInstance?: boolean;
  /** The markdown Knowledge store folder (Digests). Default `<dataDir>/knowledge`. */
  knowledgeDir: string;
  /** How many Digests an Item collects before they are rolled up into one. Default 5. */
  digestRollupAt?: number;
  /**
   * Settings that were not given (no flag, no environment variable), so the core uses what setup
   * stored, if anything.
   */
  defaulted?: { login?: true; knowledgeDir?: true };
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  return join(base, 'Kiln');
}

/**
 * Reads `--port`, `--data-dir`, `--login`, `--test-mode`, `--dev-instance` and `--widget-restart-ms` from argv, then
 * `KILN_PORT`, `KILN_DATA_DIR` and `KILN_LOGIN` from the environment, then the defaults.
 * The Knowledge store: `--knowledge-dir` / `KILN_KNOWLEDGE_DIR` and `--digest-rollup-at` / `KILN_DIGEST_ROLLUP_AT`.
 */
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  const portText = flag('--port') ?? env.KILN_PORT;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${portText}`);
  const dataDir = resolve(flag('--data-dir') ?? env.KILN_DATA_DIR ?? defaultDataDir(env));
  const loginText = flag('--login') ?? env.KILN_LOGIN;
  const login = loginText ?? 'local';
  if (login !== 'local' && login !== 'tailscale') throw new Error(`Invalid login mode: ${login} (use local or tailscale)`);
  const knowledgeText = flag('--knowledge-dir') ?? env.KILN_KNOWLEDGE_DIR;
  const knowledgeDir = resolve(knowledgeText ?? join(dataDir, 'knowledge'));
  const config: CoreConfig = { port, dataDir, testMode: argv.includes('--test-mode'), login, knowledgeDir };
  if (loginText === undefined || knowledgeText === undefined) {
    config.defaulted = {
      ...(loginText === undefined ? { login: true as const } : {}),
      ...(knowledgeText === undefined ? { knowledgeDir: true as const } : {}),
    };
  }
  const rollupText = flag('--digest-rollup-at') ?? env.KILN_DIGEST_ROLLUP_AT;
  if (rollupText !== undefined) {
    const count = Number(rollupText);
    if (!Number.isInteger(count) || count < 2) throw new Error(`Invalid --digest-rollup-at: ${rollupText} (use 2 or more)`);
    config.digestRollupAt = count;
  }
  if (argv.includes('--dev-instance')) config.devInstance = true;
  const restartText = flag('--widget-restart-ms');
  if (restartText !== undefined) {
    const ms = Number(restartText);
    if (!Number.isInteger(ms) || ms < 1) throw new Error(`Invalid --widget-restart-ms: ${restartText}`);
    config.widgetRestartMs = ms;
  }
  return config;
}
