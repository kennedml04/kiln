// A module: a declarative file that lists what one kind of work needs (skills, MCP servers,
// Exit checks, Stages, starter files) and the Widgets it requires. It lives in a module repo
// folder or under a Project's `.kiln/modules/<id>/` as `kiln-module.json`. A module never runs
// code inside Kiln: its Exit checks run in the Item's worktree, its MCP servers in the Session.

import type { ExitCheckId } from './flow.ts';
import type { Stage } from './work.ts';

export const MODULE_FILE = 'kiln-module.json';

/** Where a Project carries its own modules, one folder per module id. */
export const PROJECT_MODULES_DIR = '.kiln/modules';

/** A Claude Code MCP server entry: a local command, or a server reached over HTTP or SSE. */
export type ModuleMcpServer =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/** A named command check, run in the Item's worktree like `testCommand`; a non-zero exit fails it. */
export interface ModuleExitCheck {
  /** Unique within the module; the check is `module:<module>/<id>` in a Workflow. */
  id: string;
  name: string;
  command: string;
  /** The Stage ids it is checked on. */
  stages: string[];
  /** A built-in check it takes the place of on those Stages, e.g. `tests_pass`. Unset: it sits beside them. */
  replaces?: ExitCheckId;
}

/** A Stage the module adds to an Item kind of the Project's Workflow. */
export interface ModuleStage {
  /** The Item kind id. */
  kind: string;
  /** The Stage id it goes after. */
  after: string;
  stage: Stage;
}

/** Starter files copied into a new Project. */
export interface ModuleTemplate {
  /** A folder inside the module's folder. */
  folder: string;
  /** Lines added to the Project's `.gitignore`, e.g. `out/`. */
  ignore?: string[];
}

export interface Module {
  id: string;
  name: string;
  description: string;
  /** The wizard presets that tick it, e.g. "Software", "Printed part". */
  presets?: string[];
  needs?: { widgets?: string[] };
  /** Skill names. Until Skill repos land, each is a skill folder inside the module. */
  skills?: string[];
  /** Claude Code MCP server entries, by server name. */
  mcpServers?: Record<string, ModuleMcpServer>;
  exitChecks?: ModuleExitCheck[];
  stages?: ModuleStage[];
  template?: ModuleTemplate;
  /** File globs the Import scan uses to suggest the module, e.g. `*.kicad_pro`. */
  detect?: string[];
}
