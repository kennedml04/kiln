// A Session's skills, delivered to Claude Code without turning on any setting source: the Widget
// builds a local plugin per Session in its own data folder, holding copies of the skill folders
// Kiln named, and nothing else. The plugin has no hooks, settings or MCP servers, and the SDK is
// told not to look for any, so only the skills load. Nothing is written into the repo or worktree.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSkill } from '@kiln/widget-sdk';

/** The plugin's name: Claude Code lists its skills as `kiln-skills:<name>`. */
export const SKILLS_PLUGIN = 'kiln-skills';

/** The Session's own config folder, in the Widget's data folder. */
export const sessionConfigDir = (dataDir: string, sessionId: string) => join(dataDir, 'session-config', sessionId);

/**
 * Builds the Session's skills plugin in a new folder under its config folder (so a start under the
 * same id never shares one with an earlier start) and returns the SDK's plugin entry and the copied
 * skill folders, or nothing when the Session has no skills.
 */
export function buildSkillsPlugin(configDir: string, skills: SessionSkill[]): { plugin: SdkPluginConfig; folders: string[] } | undefined {
  if (!skills.length) return undefined;
  mkdirSync(configDir, { recursive: true });
  const root = join(mkdtempSync(join(configDir, 'start-')), SKILLS_PLUGIN);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: SKILLS_PLUGIN, description: 'The skills Kiln gave this Session', version: '0.0.0' }, null, 2)}\n`,
  );
  const folders: string[] = [];
  for (const skill of skills) {
    const target = join(root, 'skills', skill.name);
    // Copies, not links: the Session keeps the skill it started with even if the source changes.
    cpSync(skill.folder, target, { recursive: true, dereference: true, filter: (src) => !/[\\/]\.git$/.test(src) });
    folders.push(target);
  }
  return { plugin: { type: 'local', path: root, skipMcpDiscovery: true }, folders };
}

/** Removes the Session's config folder once its Claude Code has exited; a failure leaves it for later. */
export async function removeSessionConfig(configDir: string): Promise<void> {
  await rm(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}
