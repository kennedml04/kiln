// A Project's Kiln files: the `.kiln` folder at its repo root, read from the main checkout.
//
//   .kiln/workflow.json   the Project's own Workflow (optional: the default applies without it)
//   .kiln/settings.json   Project settings (test command, known commands, local-only, merge mode, Tracker)
//   .kiln/policy.json     the Project Policy (read by the Policy engine)
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import {
  PROJECT_SETTINGS_FILE,
  PROJECT_WORKFLOW_FILE,
  type ProjectFileError,
  type ProjectSettings,
  type Workflow,
} from '@kiln/widget-sdk';
import { validateWorkflow } from './workflow-validator.ts';

const KILN_DIR = '.kiln';
const WATCH_DEBOUNCE_MS = 100;

export interface ProjectFiles {
  /** The Workflow file's Workflow when it is valid; unset when there is none or it is invalid. */
  workflow?: Workflow;
  /** Whether a Workflow file is there at all (valid or not). */
  hasWorkflowFile: boolean;
  settings: ProjectSettings;
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
  const { testCommand, knownCommands, localOnly, mergeMode, tracker, github } = raw;
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
  if (settings.tracker === 'github' && !settings.github) {
    errors.push({ at: 'github', message: 'The github Tracker needs github.repo, the "owner/name" its issues are on' });
  }
  return { settings, errors };
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

  const workflowFile = readJson(root, PROJECT_WORKFLOW_FILE);
  const hasWorkflowFile = workflowFile.error !== undefined || workflowFile.value !== undefined;
  let workflow: Workflow | undefined;
  if (workflowFile.error) errors.push(workflowFile.error);
  else if (workflowFile.value !== undefined) {
    const checked = validateWorkflow(workflowFile.value);
    if (Array.isArray(checked)) errors.push(...checked.map((e) => ({ file: PROJECT_WORKFLOW_FILE, ...e })));
    else workflow = checked;
  }
  return { workflow, hasWorkflowFile, settings, errors };
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
    dirWatcher = watch(dir, changed);
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
