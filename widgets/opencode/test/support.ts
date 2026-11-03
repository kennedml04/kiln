// Installing the OpenCode Widget in a test core, from a throwaway copy of the public repo, with
// `opencode` faked by fake-opencode.mjs (or the real one, for the opt-in real run).
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRepo, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = resolve(HERE, '..');
export const FAKE_OPENCODE = join(HERE, 'fake-opencode.mjs');

/** A throwaway copy of the public repo holding the Widget at `widgets/opencode`. */
export function publicRepo(t: Cleanup): string {
  const repo = createTempRepo(t);
  cpSync(WIDGET_DIR, join(repo.path, 'widgets', 'opencode'), { recursive: true, filter: (src) => !src.includes('node_modules') });
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'OpenCode Widget');
  return repo.path;
}

/** Installs and approves the OpenCode Widget with this config; resolves once it is ready. */
export async function installOpenCode(t: Cleanup, kiln: TestKiln, config: Record<string, unknown>): Promise<void> {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: publicRepo(t), path: 'widgets/opencode', config });
  await kiln.api('POST', '/api/widgets/opencode/approve');
  await events.next('widget.ready', { timeoutMs: 15_000 });
  events.close();
}

export const GIT = 'git -c user.name=OpenCode -c user.email=opencode@kiln.invalid';

/** A scenario step for fake-opencode.mjs (see the top of that file). */
export type FakeStep =
  | { do: 'text'; text: string }
  | { do: 'usage'; input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number }
  | { do: 'bash'; command: string }
  | { do: 'edit'; path: string; content: string }
  | { do: 'webfetch'; url: string }
  | { do: 'mcp'; tool: string; args?: unknown }
  | { do: 'subagent'; description: string; steps: FakeStep[] }
  | { do: 'wait'; ms: number }
  | { do: 'end_turn' }
  | { do: 'fail'; message: string };

export interface FakeScenario {
  steps: FakeStep[];
  version?: string;
  permissionEvent?: 'asked' | 'updated';
  /** The models OpenCode knows, "provider/model" -> context window (GET /config/providers). */
  limits?: Record<string, number>;
}

export interface ToolLog {
  session: string;
  tool: string;
  pattern: string;
  outcome: 'ran' | 'denied' | 'rejected';
  ok: boolean;
  output: string;
}

export interface ConfigLog {
  cwd: string;
  config: Record<string, any>;
  password: boolean;
}

/** A fake `opencode`: the scenario it plays and what it logged. */
export function fakeOpenCode(t: Cleanup, scenario: FakeScenario) {
  const file = join(tempDir(t, 'kiln-fake-opencode'), 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  const lines = <T>(kind: string): T[] =>
    existsSync(`${file}.${kind}.jsonl`)
      ? readFileSync(`${file}.${kind}.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)
      : [];
  return {
    command: ['node', FAKE_OPENCODE, file],
    configs: () => lines<ConfigLog>('configs'),
    calls: () => lines<{ method: string; path: string; body: any; directory: string | null }>('calls'),
    tools: () => lines<ToolLog>('tools'),
  };
}

export const commitSteps = (content = 'done'): FakeStep[] => [
  { do: 'edit', path: 'contract.txt', content: `${content}\n` },
  { do: 'bash', command: 'git add -A' },
  { do: 'bash', command: `${GIT} commit -q -m "Contract ${content}"` },
];
