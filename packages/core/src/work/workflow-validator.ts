// Checks a Workflow file: every problem points at where it is, as a JSON path into the file.
import { parsePolicyLayer, type ExitCheckId, type ItemKind, type ProjectFileError, type Stage, type Workflow } from '@kiln/widget-sdk';
import { EXIT_CHECK_IDS, WORKTREE_FREE_CHECKS } from '../flow/exit-checker.ts';

export type WorkflowProblem = Omit<ProjectFileError, 'file'>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const ID = /^[a-z0-9][a-z0-9-]*$/;

export const STAGE_FIELDS = new Set([
  'id', 'name', 'gate', 'role', 'agent', 'model', 'fallbackModel', 'worktree', 'exit', 'status', 'pool', 'policy', 'mergeOnExit', 'rework', 'rollUp',
]);
const BOOLEAN_FIELDS = ['gate', 'worktree', 'mergeOnExit', 'rollUp'] as const;
const TEXT_FIELDS = ['role', 'agent', 'model', 'fallbackModel', 'status', 'pool'] as const;

/**
 * The Workflow when it is valid, else every problem found. `moduleChecks` are the
 * `module:<module>/<check>` Exit checks the Project's modules offer, which its Stages can name too.
 */
export function validateWorkflow(raw: unknown, moduleChecks: readonly string[] = []): Workflow | WorkflowProblem[] {
  const checkIds: readonly string[] = [...EXIT_CHECK_IDS, ...moduleChecks];
  const problems: WorkflowProblem[] = [];
  const problem = (at: string, message: string) => problems.push({ at, message });
  if (!isObject(raw)) return [{ at: '', message: 'A Workflow must be a JSON object' }];
  if (!isText(raw.name)) problem('name', 'A Workflow needs a name');
  if (!Array.isArray(raw.kinds) || raw.kinds.length === 0) {
    problem('kinds', 'A Workflow lists its Item kinds');
    return problems;
  }

  const kindIds = raw.kinds.map((k) => (isObject(k) ? k.id : undefined));
  raw.kinds.forEach((kind: unknown, k) => {
    const at = `kinds[${k}]`;
    if (!isObject(kind)) return problem(at, 'An Item kind must be a JSON object');
    if (!isText(kind.id) || !ID.test(kind.id)) problem(`${at}.id`, 'An Item kind needs an id of lower-case letters, digits and dashes');
    else if (kindIds.indexOf(kind.id) !== k) problem(`${at}.id`, `Another Item kind is also "${kind.id}"`);
    if (!isText(kind.name)) problem(`${at}.name`, 'An Item kind needs a name');
    if (kind.parentKind !== undefined) {
      const parent = kindIds.indexOf(kind.parentKind);
      if (!isText(kind.parentKind) || parent === -1) {
        problem(`${at}.parentKind`, `${JSON.stringify(kind.parentKind)} is not an Item kind of this Workflow`);
      } else if (parent >= k) problem(`${at}.parentKind`, 'A parent kind comes before its children in the list');
    }
    if (kind.parentRequired !== undefined) {
      if (typeof kind.parentRequired !== 'boolean') problem(`${at}.parentRequired`, 'parentRequired must be true or false');
      else if (kind.parentRequired && kind.parentKind === undefined) problem(`${at}.parentRequired`, 'A kind that needs a parent names its parentKind');
    }
    if (!Array.isArray(kind.stages) || kind.stages.length < 2) {
      problem(`${at}.stages`, 'An Item kind needs at least two Stages: the last one is where its Items have shipped');
      return;
    }
    const stageIds = kind.stages.map((s) => (isObject(s) ? s.id : undefined));
    kind.stages.forEach((stage: unknown, s) => {
      const where = `${at}.stages[${s}]`;
      if (!isObject(stage)) return problem(where, 'A Stage must be a JSON object');
      for (const field of Object.keys(stage)) if (!STAGE_FIELDS.has(field)) problem(`${where}.${field}`, `A Stage has no "${field}"`);
      if (!isText(stage.id) || !ID.test(stage.id)) problem(`${where}.id`, 'A Stage needs an id of lower-case letters, digits and dashes');
      else if (stageIds.indexOf(stage.id) !== s) problem(`${where}.id`, `Another Stage of this kind is also "${stage.id}"`);
      if (!isText(stage.name)) problem(`${where}.name`, 'A Stage needs a name');
      for (const field of BOOLEAN_FIELDS) {
        if (stage[field] !== undefined && typeof stage[field] !== 'boolean') problem(`${where}.${field}`, `${field} must be true or false`);
      }
      for (const field of TEXT_FIELDS) {
        if (stage[field] !== undefined && !isText(stage[field])) problem(`${where}.${field}`, `${field} must be a name`);
      }
      const label = `${isText(kind.name) ? kind.name : `kinds[${k}]`} > ${isText(stage.name) ? stage.name : stage.id}`;
      // A Stage that runs a Session names who runs it and on what: never a silent (expensive) default.
      if (stage.role !== undefined) {
        if (stage.agent === undefined) problem(`${where}.agent`, `${label} runs a Session, so it must name its Agent`);
        if (stage.model === undefined) problem(`${where}.model`, `${label} runs a Session, so it must name its model`);
      }
      if (stage.exit !== undefined) {
        if (!Array.isArray(stage.exit)) problem(`${where}.exit`, 'An Exit is a list of named checks');
        else {
          stage.exit.forEach((check: unknown, c) => {
            if (typeof check !== 'string' || !checkIds.includes(check)) {
              problem(`${where}.exit[${c}]`, `${JSON.stringify(check)} is not an Exit check. The checks are: ${checkIds.join(', ')}`);
            } else if (stage.worktree !== true && !WORKTREE_FREE_CHECKS.includes(check as ExitCheckId)) {
              problem(`${where}.exit[${c}]`, `${label} has no worktree, so it cannot check "${String(check)}": give it "worktree": true`);
            }
          });
        }
      }
      // A Gate (or merge on Exit) merges the Stage's branch, which only a worktree has.
      for (const field of ['gate', 'mergeOnExit'] as const) {
        if (stage[field] === true && stage.worktree !== true) {
          problem(`${where}.${field}`, `${label} has no worktree, so it has no branch for its ${field === 'gate' ? 'Gate' : 'merge on Exit'} to merge: give it "worktree": true`);
        }
      }
      if (stage.rework !== undefined) {
        const target = stageIds.indexOf(stage.rework);
        if (target === -1 || target > s) problem(`${where}.rework`, `${JSON.stringify(stage.rework)} is not this Stage or an earlier one`);
      }
      if (stage.policy !== undefined) {
        const parsed = parsePolicyLayer(stage.policy);
        if (typeof parsed === 'string') problem(`${where}.policy`, parsed);
      }
    });
  });
  if (problems.length) return problems;
  return {
    name: raw.name as string,
    kinds: (raw.kinds as ItemKind[]).map((kind) => ({ ...kind, stages: kind.stages.map((stage) => ({ ...stage }) as Stage) })),
  };
}
