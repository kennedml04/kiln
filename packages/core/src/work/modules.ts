// Modules (`kiln-module.json`): the validator, and the module sources a Project's modules resolve from.
// A module is data only: Kiln reads it and never runs anything from its folder.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { MODULE_FILE, PROJECT_MODULES_DIR, type ExitCheckId, type Module, type ProjectFileError } from '@kiln/widget-sdk';
import { EXIT_CHECK_IDS } from '../flow/exit-checker.ts';
import { STAGE_FIELDS } from './workflow-validator.ts';

export type ModuleProblem = Omit<ProjectFileError, 'file'>;

/** The default module repo, in-tree at the repo root. */
export const DEFAULT_MODULE_REPO = resolve(import.meta.dirname, '..', '..', '..', '..', 'modules');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'string');
const ID = /^[a-z0-9][a-z0-9-]*$/;

const FIELDS = ['id', 'name', 'description', 'presets', 'needs', 'skills', 'mcpServers', 'exitChecks', 'stages', 'template', 'detect'];

/** The module when its file is valid, else every problem found, each at a JSON path into the file. */
export function validateModule(raw: unknown): Module | ModuleProblem[] {
  const problems: ModuleProblem[] = [];
  const problem = (at: string, message: string) => problems.push({ at, message });
  if (!isObject(raw)) return [{ at: '', message: 'A module file must be a JSON object' }];

  if (!isText(raw.id) || !ID.test(raw.id)) problem('id', 'A module needs an id of lower-case letters, digits and dashes');
  if (!isText(raw.name)) problem('name', 'A module needs a name');
  if (!isText(raw.description)) problem('description', 'A module needs a one-line description');
  for (const field of Object.keys(raw)) {
    if (!FIELDS.includes(field)) problem(field, `A module has no "${field}". Its fields are: ${FIELDS.join(', ')}`);
  }

  if (raw.presets !== undefined && !isTextList(raw.presets)) problem('presets', 'presets must be a list of preset names');
  if (raw.needs !== undefined) {
    if (!isObject(raw.needs)) problem('needs', 'needs must be a JSON object, e.g. { "widgets": ["github"] }');
    else {
      if (raw.needs.widgets !== undefined && !isTextList(raw.needs.widgets)) problem('needs.widgets', 'needs.widgets must be a list of Widget ids');
      for (const field of Object.keys(raw.needs)) {
        if (field !== 'widgets') problem(`needs.${field}`, `needs has no "${field}": a module needs only widgets`);
      }
    }
  }
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) problem('skills', 'skills must be a list of skill names');
    else raw.skills.forEach((skill, i) => {
      if (!isText(skill) || !ID.test(skill)) problem(`skills[${i}]`, 'A skill is named by lower-case letters, digits and dashes');
    });
  }
  if (raw.mcpServers !== undefined) checkMcpServers(raw.mcpServers, problem);
  if (raw.exitChecks !== undefined) checkExitChecks(raw.exitChecks, problem);
  if (raw.stages !== undefined) checkStages(raw.stages, problem);
  if (raw.template !== undefined) checkTemplate(raw.template, problem);
  if (raw.detect !== undefined) {
    if (!Array.isArray(raw.detect)) problem('detect', 'detect must be a list of file globs');
    else raw.detect.forEach((glob, i) => {
      if (!isText(glob)) problem(`detect[${i}]`, 'A detect entry is a file glob, e.g. "*.scad"');
    });
  }
  return problems.length ? problems : (raw as unknown as Module);
}

type Problem = (at: string, message: string) => void;

function checkMcpServers(servers: unknown, problem: Problem) {
  if (!isObject(servers)) return problem('mcpServers', 'mcpServers maps server names to Claude Code MCP server entries');
  for (const [name, server] of Object.entries(servers)) {
    const at = `mcpServers.${name}`;
    if (!isObject(server)) {
      problem(at, 'An MCP server entry must be a JSON object');
      continue;
    }
    const type = server.type ?? 'stdio';
    if (type === 'http' || type === 'sse') {
      if (!isText(server.url)) problem(`${at}.url`, `An ${type} MCP server needs a url`);
      if (server.headers !== undefined && !isStringMap(server.headers)) problem(`${at}.headers`, 'headers must map names to strings');
    } else if (type === 'stdio') {
      if (!isText(server.command)) problem(`${at}.command`, 'An MCP server runs a command, or has "type": "http" or "sse" and a url');
      if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((a) => typeof a === 'string'))) {
        problem(`${at}.args`, 'args must be a list of strings');
      }
      if (server.env !== undefined && !isStringMap(server.env)) problem(`${at}.env`, 'env must map names to strings');
    } else problem(`${at}.type`, `An MCP server type is "stdio", "http" or "sse", not ${JSON.stringify(type)}`);
  }
}

function checkExitChecks(checks: unknown, problem: Problem) {
  if (!Array.isArray(checks)) return problem('exitChecks', 'exitChecks must be a list of named command checks');
  const ids = checks.map((c) => (isObject(c) ? c.id : undefined));
  checks.forEach((check: unknown, i) => {
    const at = `exitChecks[${i}]`;
    if (!isObject(check)) return problem(at, 'An Exit check must be a JSON object');
    if (!isText(check.id) || !ID.test(check.id)) problem(`${at}.id`, 'An Exit check needs an id of lower-case letters, digits and dashes');
    else if (ids.indexOf(check.id) !== i) problem(`${at}.id`, `Another Exit check of this module is also "${check.id}"`);
    if (!isText(check.name)) problem(`${at}.name`, 'An Exit check needs a name');
    if (!isText(check.command)) problem(`${at}.command`, 'An Exit check runs a command line in the worktree');
    if (!Array.isArray(check.stages) || check.stages.length === 0 || !check.stages.every((s) => isText(s) && ID.test(s))) {
      problem(`${at}.stages`, 'An Exit check lists the Stage ids it is checked on');
    }
    if (check.replaces !== undefined && !EXIT_CHECK_IDS.includes(check.replaces as ExitCheckId)) {
      problem(`${at}.replaces`, `${JSON.stringify(check.replaces)} is not an Exit check it can replace. The checks are: ${EXIT_CHECK_IDS.join(', ')}`);
    }
  });
}

/** Only the shape here: whether an added Stage fits the Workflow is checked with the effective Workflow. */
function checkStages(stages: unknown, problem: Problem) {
  if (!Array.isArray(stages)) return problem('stages', 'stages must be a list of { kind, after, stage }');
  stages.forEach((entry: unknown, i) => {
    const at = `stages[${i}]`;
    if (!isObject(entry)) return problem(at, 'An added Stage must be a JSON object: { kind, after, stage }');
    if (!isText(entry.kind)) problem(`${at}.kind`, 'An added Stage names the Item kind it goes in');
    if (!isText(entry.after)) problem(`${at}.after`, 'An added Stage names the Stage id it goes after');
    const stage = entry.stage;
    if (!isObject(stage)) return problem(`${at}.stage`, 'An added Stage carries a Stage: { id, name, ... }');
    for (const field of Object.keys(stage)) if (!STAGE_FIELDS.has(field)) problem(`${at}.stage.${field}`, `A Stage has no "${field}"`);
    if (!isText(stage.id) || !ID.test(stage.id)) problem(`${at}.stage.id`, 'A Stage needs an id of lower-case letters, digits and dashes');
    if (!isText(stage.name)) problem(`${at}.stage.name`, 'A Stage needs a name');
  });
}

function checkTemplate(template: unknown, problem: Problem) {
  if (!isObject(template)) return problem('template', 'template must be a JSON object with a folder');
  const folder = template.folder;
  if (!isText(folder) || isAbsolute(folder) || normalize(folder).split(/[\\/]/)[0] === '..') {
    problem('template.folder', `template.folder is a folder inside the module, not ${JSON.stringify(folder)}`);
  }
  if (template.ignore !== undefined && !isTextList(template.ignore)) problem('template.ignore', 'template.ignore must be a list of .gitignore lines');
}

/** A folder of module folders (`<folder>/<id>/kiln-module.json`). */
export interface ModuleSource {
  folder: string;
  /** How its files are named in problems, e.g. `.kiln/modules` for a Project's own modules. */
  label: string;
}

export interface LoadedModule {
  module: Module;
  /** The module's own folder. */
  folder: string;
  /** The label of the source it came from. */
  source: string;
}

export interface SourceProblem extends ProjectFileError {
  /** The label of the source the file is in. */
  source: string;
  /** The name of the module folder it is in: the module's id, when the file gets that right. */
  folderName: string;
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** Where a Project's modules resolve from, in order: its own `.kiln/modules`, then the module repos. */
export function moduleSources(root: string, repos: string[] = [DEFAULT_MODULE_REPO]): ModuleSource[] {
  return [{ folder: join(root, PROJECT_MODULES_DIR), label: PROJECT_MODULES_DIR }, ...repos.map((folder) => ({ folder, label: folder }))];
}

/**
 * Reads every module in the sources, in order. When two have the same id, the earlier source wins.
 * A source folder that is not there has no modules; a folder without a module file is skipped.
 */
export function loadModules(sources: ModuleSource[]): { modules: Map<string, LoadedModule>; problems: SourceProblem[] } {
  const modules = new Map<string, LoadedModule>();
  const problems: SourceProblem[] = [];
  for (const { folder, label } of sources) {
    if (!isDir(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      const dir = join(folder, name);
      const path = join(dir, MODULE_FILE);
      if (!isDir(dir) || !existsSync(path)) continue;
      const file = `${label}/${name}/${MODULE_FILE}`;
      const add = (at: string, message: string) => problems.push({ source: label, folderName: name, file, at, message });
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        add('', `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const checked = validateModule(raw);
      if (Array.isArray(checked)) {
        for (const p of checked) add(p.at, p.message);
        continue;
      }
      if (checked.id !== name) {
        add('id', `The module in folder "${name}" has the id "${checked.id}": a module folder is named by its id`);
        continue;
      }
      if (!modules.has(checked.id)) modules.set(checked.id, { module: checked, folder: dir, source: label });
    }
  }
  return { modules, problems };
}
