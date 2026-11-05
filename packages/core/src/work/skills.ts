// What a Session gets from its Project's modules: their skills and MCP servers. A skill is a
// folder holding `SKILL.md`; the core only finds the folders and hands them to the Agent Widget in
// `SessionStart.skills`, which copies them into the Session's own config, never into the repo.
//
// `skillFolders` is the one place a folder of skill folders is read, so Project skills
// (`.claude/skills/<name>/SKILL.md`, skill-and-widget-repos issue 05) and Skill repos reuse it.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_SETTINGS_FILE, type ModuleMcpServer, type ProjectFileError, type SessionSkill } from '@kiln/widget-sdk';
import type { LoadedModule } from './modules.ts';

export const SKILL_FILE = 'SKILL.md';

/** Where a module keeps its own skill folders, until Skill repos land. */
export const MODULE_SKILLS_DIR = 'skills';

/** The MCP server name Kiln's own tools use; a module cannot take it. */
export const KILN_MCP_SERVER = 'kiln';

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** The skill folders in `folder` (`<folder>/<name>/SKILL.md`), by name, sorted. A missing folder has none. */
export function skillFolders(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return found;
  for (const name of readdirSync(folder).sort()) {
    const dir = join(folder, name);
    if (isFile(join(dir, SKILL_FILE))) found.set(name, dir);
  }
  return found;
}

/** The skill folder a module's skill name resolves to, or undefined when the module has none of that name. */
const moduleSkillFolder = (loaded: LoadedModule, name: string) => skillFolders(join(loaded.folder, MODULE_SKILLS_DIR)).get(name);

/**
 * The skills and MCP servers a Session in a Project with these modules runs with, in module order.
 * When two modules give a skill or server the same name, the earlier module's wins. A skill whose
 * folder is missing is left out (the Project shows the error, see `moduleProblems`).
 */
export function moduleSessionKit(modules: LoadedModule[]): { skills: SessionSkill[]; mcpServers: Record<string, ModuleMcpServer> } {
  const skills: SessionSkill[] = [];
  const mcpServers: Record<string, ModuleMcpServer> = {};
  for (const loaded of modules) {
    const { module } = loaded;
    for (const name of module.skills ?? []) {
      const folder = moduleSkillFolder(loaded, name);
      if (folder && !skills.some((s) => s.name === name)) skills.push({ name, source: `module:${module.id}`, commit: null, folder });
    }
    for (const [name, server] of Object.entries(module.mcpServers ?? {})) {
      if (name !== KILN_MCP_SERVER && !(name in mcpServers)) mcpServers[name] = server;
    }
  }
  return { skills, mcpServers };
}

/**
 * What is wrong with a Project's modules as this install stands: a needed Widget that isn't
 * installed, a skill with no folder, or an MCP server named `kiln`. Each problem is on the module's
 * entry in `.kiln/settings.json` and names what is missing. `installedWidgets` unset skips the Widget check.
 */
export function moduleProblems(modules: LoadedModule[], ids: string[], installedWidgets?: string[]): ProjectFileError[] {
  const errors: ProjectFileError[] = [];
  for (const loaded of modules) {
    const { module } = loaded;
    const at = `modules[${Math.max(0, ids.indexOf(module.id))}]`;
    const add = (message: string) => errors.push({ file: PROJECT_SETTINGS_FILE, at, message });
    if (installedWidgets) {
      for (const widget of module.needs?.widgets ?? []) {
        if (!installedWidgets.includes(widget)) add(`The ${JSON.stringify(module.id)} module needs the ${JSON.stringify(widget)} Widget, which isn't installed. Install it from Widgets.`);
      }
    }
    for (const name of module.skills ?? []) {
      if (!moduleSkillFolder(loaded, name)) {
        add(`The ${JSON.stringify(module.id)} module lists the skill ${JSON.stringify(name)}, but it has no ${MODULE_SKILLS_DIR}/${name}/${SKILL_FILE}`);
      }
    }
    if (module.mcpServers && KILN_MCP_SERVER in module.mcpServers) {
      add(`The ${JSON.stringify(module.id)} module names an MCP server "${KILN_MCP_SERVER}": that name is Kiln's own tools`);
    }
  }
  return errors;
}
