// Installs the Claude Code Widget into a test core, with the fake SDK playing a scenario.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import type { FakeLogEntry, FakeScenario } from './fake-sdk/scenario.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WIDGET_DIR = resolve(HERE, '..');
const FAKE_SDK = pathToFileURL(join(HERE, 'fake-sdk', 'sdk.ts')).href;

export interface InstalledClaudeCode {
  widgetId: string;
  /** Everything the fake SDK saw, in order. */
  log(): FakeLogEntry[];
}

/** Installs and approves the Widget from its folder with this config; resolves once it is ready. */
export async function installClaudeCodeWidget(kiln: TestKiln, config: Record<string, unknown>): Promise<void> {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: WIDGET_DIR, config });
  await kiln.api('POST', '/api/widgets/claude-code/approve');
  await events.next('widget.ready', { timeoutMs: 20_000 });
  events.close();
}

/**
 * Installs and approves the Widget with the fake SDK playing `scenario`; resolves once it is ready.
 * It runs `claude-haiku-5-5` unless `config` names another model: Kiln starts no Session on no model.
 */
export async function installClaudeCode(
  t: Cleanup,
  kiln: TestKiln,
  scenario: FakeScenario,
  config: Record<string, unknown> = {},
): Promise<InstalledClaudeCode> {
  const scenarioFile = join(tempDir(t, 'kiln-fake-claude'), 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  await installClaudeCodeWidget(kiln, { sdkModule: FAKE_SDK, fakeScenario: scenarioFile, model: 'claude-haiku-5-5', ...config });
  const logFile = `${scenarioFile}.log`;
  return {
    widgetId: 'claude-code',
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeLogEntry)
        : [],
  };
}
