// A Project's Kiln files: the `.kiln` folder at its repo root, read from the main checkout.
//
//   .kiln/workflow.json   the Project's own Workflow (optional: the default applies without it)
//   .kiln/settings.json   Project settings (test command, known commands, local-only, merge mode, Tracker)
//   .kiln/policy.json     the Project Policy (read by the Policy engine)
//   .kiln/modules/<id>/   the Project's own modules (`kiln-module.json`), ahead of the module repos
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_MODULES_DIR,
  PROJECT_SETTINGS_FILE,
  PROJECT_WORKFLOW_FILE,
  type ProjectFileError,
  type ProjectSettings,
  type Workflow,
} from '@kiln/widget-sdk';
import { moduleCheckIds } from './effective-workflow.ts';
import { loadModules, moduleSources, type LoadedModule } from './modules.ts';
import { validateWorkflow } from './workflow-validator.ts';

const KILN_DIR = '.kiln';
const WATCH_DEBOUNCE_MS = 100;

export interface ProjectFiles {
  /** The Workflow file's Workflow when it is valid; unset when there is none or it is invalid. */
  workflow?: Workflow;
  /** Whether a Workflow file is there at all (valid or not). */
  hasWorkflowFile: boolean;
  settings: ProjectSettings;
  /** The modules `settings.modules` names that resolved, in that order. */
  modules: LoadedModule[];
  errors: ProjectFileError[];
}

type Parsed = { value?: unknown; error?: ProjectFileError };

/** Reads one JSON file; unset `value` when it is missing. */
function readJson(root: string, file: string): Parsed {
  const path = join(root, file);
  if (!existsSync(path)) return {};
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { error: { file, at: '', message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks `.kiln/settings.json`; every problem names the setting it is about. */
export function validateSettings(raw: unknown): { settings: ProjectSettings; errors: Omit<ProjectFileError, 'file'>[] } {
  const errors: Omit<ProjectFileError, 'file'>[] = [];
  const settings: ProjectSettings = {};
  if (!isObject(raw)) return { settings, errors: [{ at: '', message: 'The settings must be a JSON object' }] };
  const { testCommand, knownCommands, localOnly, mergeMode, tracker, github, modules } = raw;
  if (testCommand !== undefined) {
    if (typeof testCommand === 'string' && testCommand.trim()) settings.testCommand = testCommand;
    else errors.push({ at: 'testCommand', message: 'testCommand must be a command line' });
  }
  if (knownCommands !== undefined) {
    if (Array.isArray(knownCommands) && knownCommands.every((c) => typeof c === 'string' && c.trim())) {
      settings.knownCommands = knownCommands as string[];
    } else errors.push({ at: 'knownCommands', message: 'knownCommands must be a list of command lines' });
  }
  if (localOnly !== undefined) {
    if (typeof localOnly === 'boolean') settings.localOnly = localOnly;
    else errors.push({ at: 'localOnly', message: 'localOnly must be true or false' });
  }
  if (mergeMode !== undefined) {
    if (mergeMode === 'merge' || mergeMode === 'pr') settings.mergeMode = mergeMode;
    else errors.push({ at: 'mergeMode', message: `mergeMode must be "merge" or "pr", not ${JSON.stringify(mergeMode)}` });
  }
  if (tracker !== undefined) {
    if (tracker === 'markdown' || tracker === 'github') settings.tracker = tracker;
    else errors.push({ at: 'tracker', message: `tracker must be "markdown" (built in) or "github" (GitHub Issues), not ${JSON.stringify(tracker)}` });
  }
  if (github !== undefined) {
    const repo = isObject(github) ? github.repo : undefined;
    const remote = isObject(github) ? github.remote : undefined;
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      errors.push({ at: 'github.repo', message: 'github.repo must be "owner/name"' });
    } else if (remote !== undefined && (typeof remote !== 'string' || !remote.trim())) {
      errors.push({ at: 'github.remote', message: 'github.remote must name a git remote' });
    } else settings.github = { repo, ...(remote ? { remote } : {}) };
  }
  if (modules !== undefined) {
    if (Array.isArray(modules) && modules.every((m) => typeof m === 'string' && m.trim())) settings.modules = modules as string[];
    else errors.push({ at: 'modules', message: 'modules must be a list of module ids' });
  }
  if (settings.tracker === 'github' && !settings.github) {
    errors.push({ at: 'github', message: 'The github Tracker needs github.repo, the "owner/name" its issues are on' });
  }
  return { settings, errors };
}

/**
 * Resolves `settings.modules`: an id no source has is an error on the setting, and the Project's
 * own module files are checked. Problems in a module repo are not the Project's, so only the ids
 * they leave unresolved show.
 */
function resolveModules(root: string, settings: ProjectSettings): { modules: LoadedModule[]; errors: ProjectFileError[] } {
  const { modules: known, problems } = loadModules(moduleSources(root));
  const errors: ProjectFileError[] = [];
  const modules: LoadedModule[] = [];
  const available = [...known.keys()].sort();
  (settings.modules ?? []).forEach((id, i) => {
    const found = known.get(id);
    if (found) return modules.push(found);
    const broken = problems.find((p) => p.folderName === id);
    const listed = available.length ? `The modules are: ${available.join(', ')}` : 'No modules are available';
    const message = broken ? `The ${JSON.stringify(id)} module did not load: see ${broken.file}` : `${JSON.stringify(id)} is not a module. ${listed}`;
    errors.push({ file: PROJECT_SETTINGS_FILE, at: `modules[${i}]`, message });
  });
  if (settings.modules) settings.modules = modules.map((m) => m.module.id);
  for (const { source, file, at, message } of problems) if (source === PROJECT_MODULES_DIR) errors.push({ file, at, message });
  return { modules, errors };
}

/** Reads and checks the Project's Kiln files in the checkout at `root`. */
export function readProjectFiles(root: string): ProjectFiles {
  const errors: ProjectFileError[] = [];
  const settingsFile = readJson(root, PROJECT_SETTINGS_FILE);
  let settings: ProjectSettings = {};
  if (settingsFile.error) errors.push(settingsFile.error);
  else if (settingsFile.value !== undefined) {
    const checked = validateSettings(settingsFile.value);
    settings = checked.settings;
    errors.push(...checked.errors.map((e) => ({ file: PROJECT_SETTINGS_FILE, ...e })));
  }
  const resolved = resolveModules(root, settings);
  errors.push(...resolved.errors);

  const workflowFile = readJson(root, PROJECT_WORKFLOW_FILE);
  const hasWorkflowFile = workflowFile.error !== undefined || workflowFile.value !== undefined;
  let workflow: Workflow | undefined;
  if (workflowFile.error) errors.push(workflowFile.error);
  else if (workflowFile.value !== undefined) {
    const checked = validateWorkflow(workflowFile.value, moduleCheckIds(resolved.modules));
    if (Array.isArray(checked)) errors.push(...checked.map((e) => ({ file: PROJECT_WORKFLOW_FILE, ...e })));
    else workflow = checked;
  }
  return { workflow, hasWorkflowFile, settings, modules: resolved.modules, errors };
}

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** Calls `onChange` (debounced) whenever a file in `.kiln` may have changed. Returns an unwatch function. */
export function watchProjectFiles(root: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirWatcher: FSWatcher | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  };
  const attach = () => {
    const dir = join(root, KILN_DIR);
    if (dirWatcher || !isDir(dir)) return;
    // Recursive, so a change to a module under `.kiln/modules` is seen too.
    dirWatcher = watch(dir, { recursive: true }, changed);
    dirWatcher.on('error', () => {
      dirWatcher?.close();
      dirWatcher = undefined;
      changed();
    });
  };
  // The repo root is watched only to see `.kiln` appear or go.
  const rootWatcher = watch(root, (_event, name) => {
    if (name !== KILN_DIR) return;
    dirWatcher?.close();
    dirWatcher = undefined;
    attach();
    changed();
  });
  rootWatcher.on('error', () => undefined);
  attach();
  return () => {
    clearTimeout(timer);
    rootWatcher.close();
    dirWatcher?.close();
  };
}
