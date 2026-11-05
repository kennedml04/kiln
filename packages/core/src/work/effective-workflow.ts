// The effective Workflow: the Project's Workflow with its modules' Stages inserted, in module order,
// and their Exit checks applied (beside a Stage's checks, or in place of the one they replace).
// Pure: the Workflow passed in is never changed.
import {
  MODULE_FILE,
  PROJECT_SETTINGS_FILE,
  type ModuleExitCheckId,
  type ProjectFileError,
  type Stage,
  type Workflow,
} from '@kiln/widget-sdk';
import type { LoadedModule } from './modules.ts';
import { validateWorkflow, type WorkflowProblem } from './workflow-validator.ts';

/** The Exit check id a Workflow names a module's check by. */
export const moduleCheckId = (module: string, check: string): ModuleExitCheckId => `module:${module}/${check}`;

/** The module and check a `module:<module>/<check>` id names; unset for any other id. */
export function parseModuleCheckId(id: string): { module: string; check: string } | undefined {
  const match = /^module:([^/]+)\/(.+)$/.exec(id);
  return match ? { module: match[1]!, check: match[2]! } : undefined;
}

/** How a module's file is named in a Project error. */
export const moduleFileOf = (loaded: LoadedModule) => `${loaded.source}/${loaded.module.id}/${MODULE_FILE}`;

/** Every `module:<module>/<check>` id the modules offer. */
export const moduleCheckIds = (modules: LoadedModule[]): ModuleExitCheckId[] =>
  modules.flatMap(({ module }) => (module.exitChecks ?? []).map((c) => moduleCheckId(module.id, c.id)));

interface Where {
  file: string;
  at: string;
}

const PATH = /^kinds\[(\d+)\](?:\.stages\[(\d+)\])?(.*)$/;

/** A validator problem keyed by kind and Stage id rather than index, so it matches across insertions. */
function keyOf(workflow: Workflow, problem: WorkflowProblem): string {
  const match = PATH.exec(problem.at);
  if (!match) return `${problem.at}|${problem.message}`;
  const kind = workflow.kinds[Number(match[1])];
  const stage = match[2] === undefined ? undefined : kind?.stages[Number(match[2])];
  return `${kind?.id}/${stage?.id ?? ''}${match[3]}|${problem.message}`;
}

/**
 * The Project's Workflow with its modules applied, or the Project errors that stop it, each pointing
 * into the module file that caused it. Problems the Workflow already had on its own are not the
 * modules' and are not reported (the shipped default leaves Agents and models to setup).
 */
export function effectiveWorkflow(workflow: Workflow, modules: LoadedModule[]): Workflow | ProjectFileError[] {
  if (!modules.length) return workflow;
  const result = structuredClone(workflow);
  const errors: ProjectFileError[] = [];
  /** Each added Stage, where it is in its module file, and the Stage it was added after. */
  const added = new Map<Stage, Where & { after: string }>();
  /** Each module check, where its `stages` list is. */
  const checks = new Map<string, Where>();

  for (const loaded of modules) {
    const { module } = loaded;
    const file = moduleFileOf(loaded);
    (module.stages ?? []).forEach((entry, i) => {
      const at = `stages[${i}]`;
      const kind = result.kinds.find((k) => k.id === entry.kind);
      if (!kind) {
        const kinds = result.kinds.map((k) => k.id).join(', ');
        return errors.push({ file, at: `${at}.kind`, message: `${JSON.stringify(entry.kind)} is not an Item kind of the Workflow. Its kinds are: ${kinds}` });
      }
      let index = kind.stages.findIndex((s) => s.id === entry.after);
      if (index === -1) {
        const stages = kind.stages.map((s) => s.id).join(', ');
        return errors.push({ file, at: `${at}.after`, message: `${JSON.stringify(entry.after)} is not a Stage of ${kind.name}. Its Stages are: ${stages}` });
      }
      if (kind.stages.some((s) => s.id === entry.stage.id)) {
        return errors.push({ file, at: `${at}.stage.id`, message: `${kind.name} already has a Stage ${JSON.stringify(entry.stage.id)}` });
      }
      // After the Stages earlier modules added after the same Stage, so module order holds.
      while (index + 1 < kind.stages.length && added.get(kind.stages[index + 1]!)?.after === entry.after) index++;
      const stage = structuredClone(entry.stage);
      kind.stages.splice(index + 1, 0, stage);
      added.set(stage, { file, at: `${at}.stage`, after: entry.after });
    });
    (module.exitChecks ?? []).forEach((check, j) => {
      const id = moduleCheckId(module.id, check.id);
      checks.set(id, { file, at: `exitChecks[${j}].stages` });
      check.stages.forEach((stageId, n) => {
        const targets = result.kinds.flatMap((k) => k.stages.filter((s) => s.id === stageId));
        if (!targets.length) {
          return errors.push({ file, at: `exitChecks[${j}].stages[${n}]`, message: `${JSON.stringify(stageId)} is not a Stage of the Workflow` });
        }
        for (const stage of targets) {
          const exit = stage.exit ?? [];
          if (exit.includes(id)) continue;
          const replaced = check.replaces ? exit.indexOf(check.replaces) : -1;
          stage.exit = replaced === -1 ? [...exit, id] : [...exit.slice(0, replaced), id, ...exit.slice(replaced + 1)];
        }
      });
    });
  }

  const ids = [...checks.keys()];
  const validated = validateWorkflow(result, ids);
  if (!Array.isArray(validated)) return errors.length ? errors : validated;
  const own = validateWorkflow(workflow, ids);
  const known = new Set(Array.isArray(own) ? own.map((p) => keyOf(workflow, p)) : []);
  for (const problem of validated) {
    if (known.has(keyOf(result, problem))) continue;
    errors.push(blame(result, problem, added, checks));
  }
  return errors.length ? errors : result;
}

/** Points a problem in the effective Workflow at the module file entry that caused it. */
function blame(workflow: Workflow, problem: WorkflowProblem, added: Map<Stage, Where>, checks: Map<string, Where>): ProjectFileError {
  const match = PATH.exec(problem.at);
  const stage = match?.[2] === undefined ? undefined : workflow.kinds[Number(match[1])]?.stages[Number(match[2])];
  const rest = match?.[3] ?? '';
  const exitAt = /^\.exit\[(\d+)\]/.exec(rest);
  const check = exitAt ? checks.get(String(stage?.exit?.[Number(exitAt[1])])) : undefined;
  if (check) return { ...check, message: problem.message };
  const stageAt = stage && added.get(stage);
  if (stageAt) return { file: stageAt.file, at: `${stageAt.at}${rest}`, message: problem.message };
  return { file: PROJECT_SETTINGS_FILE, at: 'modules', message: `With its modules, the Workflow has a problem at ${problem.at}: ${problem.message}` };
}
