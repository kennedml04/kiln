// The Policy engine (ADR 0006): the Org layer in SQLite, the Project layer in the repo's
// `.kiln/policy.json`, the Stage layer in the Workflow, and the effective Policy a Session runs under.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  effectivePolicy,
  CHAT_POLICY,
  layerDecision,
  ORG_POLICY_DEFAULT,
  parsePolicyLayer,
  POLICY_ACTIONS,
  PROJECT_POLICY_FILE,
  PROJECT_THREAD_KIND,
  PROJECT_THREAD_POLICY,
  projectPolicyTemplate,
  type EffectivePolicy,
  type OrgPolicy,
  type OrgPolicyUpdate,
  type PolicyAction,
  type PolicyLayer,
  type PolicyRule,
  type PolicyView,
  type Project,
  type WidgetSourcePolicy,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { readProjectSettings } from '../flow/exit-checker.ts';
import { gitSync } from '../flow/git.ts';
import { WorkError } from '../work/work.ts';

const ORG_KEY = 'policy';

/** Where a Session's Policy comes from: its Project, and its Item kind and Stage in the Workflow. */
export interface PolicyScope {
  project: Project;
  kind: string;
  stage: string;
}

export interface PolicyEngine {
  org(): OrgPolicy;
  /** Admin work. 400 for a malformed update. */
  updateOrg(update: OrgPolicyUpdate): OrgPolicy;
  /** The Project layer from its Policy file (local-only Projects always deny external writes). 409 if the file is malformed. */
  projectLayer(project: Project): PolicyLayer;
  stageLayer(scope: PolicyScope): PolicyLayer;
  effective(scope: PolicyScope): EffectivePolicy;
  /** What a Scratch chat Session may do: the Org layer plus the chat Stage layer (no Project layer). */
  chat(): EffectivePolicy;
  view(scope: PolicyScope): PolicyView;
  /**
   * Whether "Always allow" can be offered for this request: every layer but the Project's allows
   * it, so a Project rule is all that stands in the way. (The Stage layer counts too: a rule in the
   * Project file could not loosen a Stage that asks.)
   */
  alwaysAllowOffered(scope: PolicyScope, action: PolicyAction, detail: string): boolean;
  /**
   * Writes one narrow allow rule into the Project Policy file and commits only that file, as Kiln.
   * Returns the commit (null outside git). 409 when the file has uncommitted changes.
   */
  alwaysAllow(project: Project, rule: { action: PolicyAction; match: string }): string | null;
  /** Writes the Project Policy template when a Project is registered, unless it has a Policy file already. */
  writeTemplate(project: Project): void;
}

export interface PolicyDeps {
  db: DatabaseSync;
  bus: EventBus;
  /** The Org Policy's Widget sources, kept by the Widget lifecycle (ticket 19). */
  sources: { get(): WidgetSourcePolicy; set(policy: WidgetSourcePolicy): WidgetSourcePolicy };
}

const git = gitSync;

const inGit = (cwd: string) => {
  try {
    git(cwd, 'rev-parse', '--is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
};

/** Writes the file, then commits it alone (leaving anything else staged or changed alone). */
function commitOnly(root: string, relativePath: string, content: string, message: string): string | null {
  const file = join(root, relativePath);
  const tracked = inGit(root);
  if (tracked && existsSync(file) && git(root, 'status', '--porcelain', '--', relativePath).trim()) {
    throw new WorkError(409, `${relativePath} has uncommitted changes in the main checkout`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (!tracked) return null;
  git(root, 'add', '--', relativePath);
  git(root, 'commit', '-q', '-m', message, '--', relativePath);
  return git(root, 'rev-parse', 'HEAD').trim();
}

const format = (layer: PolicyLayer) => `${JSON.stringify(layer, null, 2)}\n`;

export function createPolicyEngine({ db, bus, sources }: PolicyDeps): PolicyEngine {
  const read = db.prepare('SELECT value FROM org_policy WHERE key = ?');
  const write = db.prepare('INSERT INTO org_policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

  const orgLayer = (): Required<PolicyLayer> => {
    const row = read.get(ORG_KEY) as { value: string } | undefined;
    const stored = row ? (JSON.parse(row.value) as PolicyLayer) : {};
    return { actions: { ...ORG_POLICY_DEFAULT, ...stored.actions }, rules: stored.rules ?? [] };
  };

  const org = (): OrgPolicy => {
    const layer = orgLayer();
    return { actions: layer.actions as OrgPolicy['actions'], rules: layer.rules, widgetSources: sources.get().allowed };
  };

  const readFileLayer = (project: Project): PolicyLayer => {
    const file = join(project.path, PROJECT_POLICY_FILE);
    if (!existsSync(file)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new WorkError(409, `${PROJECT_POLICY_FILE} in ${project.name} is not valid JSON`);
    }
    const layer = parsePolicyLayer(parsed);
    if (typeof layer === 'string') throw new WorkError(409, `${PROJECT_POLICY_FILE} in ${project.name}: ${layer}`);
    return layer;
  };

  const projectLayer = (project: Project): PolicyLayer => {
    const layer = readFileLayer(project);
    if (!readProjectSettings(project.path).localOnly) return layer;
    return { ...layer, actions: { ...layer.actions, external_writes: 'deny' } };
  };

  // A Project Thread Session's Stage is Kiln's own, not the Workflow's: its read-only Policy.
  const stageLayer = ({ project, kind, stage }: PolicyScope): PolicyLayer =>
    kind === PROJECT_THREAD_KIND
      ? PROJECT_THREAD_POLICY
      : (project.workflow.kinds.find((k) => k.id === kind)?.stages.find((s) => s.id === stage)?.policy ?? {});

  const knownCommands = (project: Project) => {
    const settings = readProjectSettings(project.path);
    return [...new Set([...(settings.testCommand ? [settings.testCommand] : []), ...(settings.knownCommands ?? [])])];
  };

  const effective = (scope: PolicyScope) => {
    const policy = effectivePolicy([orgLayer(), projectLayer(scope.project), stageLayer(scope)], knownCommands(scope.project));
    if (!readProjectSettings(scope.project.path).localOnly) return policy;
    // Local-only denies every external write: no narrow rule in any layer can allow one.
    return { ...policy, rules: policy.rules.filter((r) => r.action !== 'external_writes') };
  };

  return {
    org,

    updateOrg(update) {
      const body = (update ?? {}) as OrgPolicyUpdate;
      const parsed = parsePolicyLayer({ actions: body.actions, rules: body.rules });
      if (typeof parsed === 'string') throw new WorkError(400, parsed);
      if (body.widgetSources !== undefined) {
        const allowed = body.widgetSources;
        if (allowed !== null && (!Array.isArray(allowed) || allowed.some((s) => typeof s !== 'string' || !s))) {
          throw new WorkError(400, 'widgetSources must be null (any source) or a list of sources');
        }
      }
      const current = orgLayer();
      const next: PolicyLayer = {
        actions: Object.fromEntries(POLICY_ACTIONS.map((a) => [a, parsed.actions?.[a] ?? current.actions[a]])),
        rules: parsed.rules ?? current.rules,
      };
      write.run(ORG_KEY, JSON.stringify(next));
      if (body.widgetSources !== undefined) sources.set({ allowed: body.widgetSources });
      const policy = org();
      bus.publish('org_policy.changed', policy);
      return policy;
    },

    projectLayer,
    stageLayer,
    effective,
    chat: () => effectivePolicy([orgLayer(), CHAT_POLICY], []),

    view: (scope) => ({ org: org(), project: projectLayer(scope.project), stage: stageLayer(scope), effective: effective(scope) }),

    alwaysAllowOffered: (scope, action, detail) =>
      layerDecision(orgLayer(), action, detail) === 'allow' && layerDecision(stageLayer(scope), action, detail) === 'allow',

    alwaysAllow(project, { action, match }) {
      const layer = readFileLayer(project);
      const rules = (layer.rules ?? []).filter((r) => !(r.action === action && r.match === match));
      const rule: PolicyRule = { action, match, decision: 'allow' };
      const next: PolicyLayer = { ...layer, rules: [...rules, rule] };
      const commit = commitOnly(project.path, PROJECT_POLICY_FILE, format(next), `Kiln: always allow ${action} ${JSON.stringify(match)}`);
      bus.publish('project_policy.changed', { projectId: project.id, rule, commit });
      return commit;
    },

    writeTemplate(project) {
      if (existsSync(join(project.path, PROJECT_POLICY_FILE))) return;
      const template = projectPolicyTemplate(readProjectSettings(project.path).localOnly === true);
      commitOnly(project.path, PROJECT_POLICY_FILE, format(template), 'Kiln: add the Project Policy');
    },
  };
}
