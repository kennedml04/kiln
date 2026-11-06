// Kiln's Policy (ADR 0006): what a Session may do, over abstract actions, in three layers.
// Org (Kiln's data, Admins edit it) -> Project (`.kiln/policy.json` in the repo) -> Stage (the Workflow).
// The effective rule for an action is the strictest across the layers: deny beats ask beats allow.
// Each Agent Widget translates the effective Policy it gets at Session start into its tool's own
// settings, and reports a permission request for anything the Policy says to ask about.
import type { KilnEvent } from './index.ts';

export type PolicyAction =
  | 'worktree_read'
  | 'worktree_write'
  /** The Project's known commands (`knownCommands` and `testCommand` in `.kiln/settings.json`). */
  | 'known_commands'
  | 'other_commands'
  /** Network access; rules match a domain. */
  | 'network'
  /** Push, PR, issue or comment writes. */
  | 'external_writes'
  | 'outside_worktree';

export const POLICY_ACTIONS: readonly PolicyAction[] = [
  'worktree_read',
  'worktree_write',
  'known_commands',
  'other_commands',
  'network',
  'external_writes',
  'outside_worktree',
];

/** How people read an action, e.g. in a Permission Ask. */
export const POLICY_ACTION_NAMES: Record<PolicyAction, string> = {
  worktree_read: 'Read in the worktree',
  worktree_write: 'Write in the worktree',
  known_commands: 'Run a known command',
  other_commands: 'Run a shell command',
  network: 'Reach a network domain',
  external_writes: 'Write outside Kiln (push, PR, issue or comment)',
  outside_worktree: 'Act outside the worktree',
};

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export const POLICY_DECISIONS: readonly PolicyDecision[] = ['allow', 'ask', 'deny'];

/**
 * A narrow rule: one command or domain for one action. `match` is the exact command or domain,
 * or a prefix ending in `*` (`git push *`).
 */
export interface PolicyRule {
  action: PolicyAction;
  match: string;
  decision: PolicyDecision;
}

/** One layer. An action a layer leaves out is not restricted by it. */
export interface PolicyLayer {
  actions?: Partial<Record<PolicyAction, PolicyDecision>>;
  rules?: PolicyRule[];
}

/** `GET/PUT /api/org-policy`. A PUT may leave fields out; `actions` given are merged into the current ones. */
export interface OrgPolicy {
  actions: Record<PolicyAction, PolicyDecision>;
  rules: PolicyRule[];
  /** Where Widgets may be installed from (see `WidgetSourcePolicy`); null allows any source. */
  widgetSources: string[] | null;
}

export interface OrgPolicyUpdate {
  actions?: Partial<Record<PolicyAction, PolicyDecision>>;
  rules?: PolicyRule[];
  widgetSources?: string[] | null;
}

/**
 * What a Session runs under (`SessionStart.policy`). `actions` is each action's rule; `rules` are
 * the commands or domains that differ from it. Use `decide()` to look one request up.
 */
export interface EffectivePolicy {
  actions: Record<PolicyAction, PolicyDecision>;
  rules: PolicyRule[];
  /** The commands that count as `known_commands` for this Project. */
  knownCommands: string[];
}

/** `GET /api/projects/:id/policy?kind=<kind>&stage=<stage>`: each layer and the effective Policy. */
export interface PolicyView {
  org: OrgPolicy;
  project: PolicyLayer;
  stage: PolicyLayer;
  effective: EffectivePolicy;
}

/** Where the Project Policy lives in the Project's repo. */
export const PROJECT_POLICY_FILE = '.kiln/policy.json';

/** The Org default: everything allowed except acting outside the worktree, which asks. */
export const ORG_POLICY_DEFAULT: Record<PolicyAction, PolicyDecision> = {
  worktree_read: 'allow',
  worktree_write: 'allow',
  known_commands: 'allow',
  other_commands: 'allow',
  network: 'allow',
  external_writes: 'allow',
  outside_worktree: 'ask',
};

/** The Project Policy written when a Project is registered. A local-only Project denies external writes. */
export function projectPolicyTemplate(localOnly: boolean): PolicyLayer {
  return {
    actions: { other_commands: 'ask', network: 'ask', external_writes: localOnly ? 'deny' : 'ask' },
    rules: [],
  };
}

const RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** The strictest of these decisions (allow when there are none). */
export const strictest = (...decisions: PolicyDecision[]): PolicyDecision =>
  decisions.reduce<PolicyDecision>((a, b) => (RANK[b] > RANK[a] ? b : a), 'allow');

/** A command that runs another inside its arguments: `$(...)`, backquotes, `<(...)`. */
const RUNS_MORE = /\$\(|`|[<>]\(/;

// A prefix rule that allows a command allows its arguments, not another command run inside them:
// `npm run lint *` doesn't allow `npm run lint $(rm -rf src)` (an exact rule still does).
const matches = (rule: PolicyRule, action: PolicyAction, detail: string) =>
  rule.action === action &&
  (rule.match.endsWith('*')
    ? detail.startsWith(rule.match.slice(0, -1)) &&
      !(rule.decision === 'allow' && (action === 'other_commands' || action === 'known_commands') && RUNS_MORE.test(detail.slice(rule.match.length - 1)))
    : rule.match === detail);

/** What one layer says about a request: its matching rules (strictest), else its rule for the action. */
export function layerDecision(layer: PolicyLayer, action: PolicyAction, detail?: string): PolicyDecision {
  const hits = detail === undefined ? [] : (layer.rules ?? []).filter((r) => matches(r, action, detail));
  if (hits.length) return strictest(...hits.map((r) => r.decision));
  return layer.actions?.[action] ?? 'allow';
}

/** The strictest of the layers, for every action and every rule any layer names. */
export function effectivePolicy(layers: PolicyLayer[], knownCommands: string[] = []): EffectivePolicy {
  const actions = Object.fromEntries(
    POLICY_ACTIONS.map((action) => [action, strictest(...layers.map((l) => layerDecision(l, action)))]),
  ) as Record<PolicyAction, PolicyDecision>;
  const rules: PolicyRule[] = [];
  const seen = new Set<string>();
  for (const rule of layers.flatMap((l) => l.rules ?? [])) {
    const key = `${rule.action}\n${rule.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const decision = strictest(...layers.map((l) => layerDecision(l, rule.action, rule.match)));
    if (decision !== actions[rule.action]) rules.push({ action: rule.action, match: rule.match, decision });
  }
  return { actions, rules, knownCommands: [...knownCommands] };
}

/** What the effective Policy says about one request (an action plus its command or domain). */
export function decide(policy: EffectivePolicy, action: PolicyAction, detail: string): PolicyDecision {
  const hits = policy.rules.filter((r) => matches(r, action, detail));
  return hits.length ? strictest(...hits.map((r) => r.decision)) : policy.actions[action];
}

export const isPolicyAction = (value: unknown): value is PolicyAction => POLICY_ACTIONS.includes(value as PolicyAction);

/**
 * Checks a layer read from a file or a request. Returns the clean layer, or a message saying what
 * is wrong.
 */
export function parsePolicyLayer(input: unknown): PolicyLayer | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'A Policy is a JSON object';
  const raw = input as Record<string, unknown>;
  const layer: PolicyLayer = {};
  if (raw.actions !== undefined) {
    if (raw.actions === null || typeof raw.actions !== 'object' || Array.isArray(raw.actions)) return '"actions" must be an object';
    const actions: Partial<Record<PolicyAction, PolicyDecision>> = {};
    for (const [action, decision] of Object.entries(raw.actions)) {
      if (!isPolicyAction(action)) return `Unknown action "${action}" (one of ${POLICY_ACTIONS.join(', ')})`;
      if (!POLICY_DECISIONS.includes(decision as PolicyDecision)) return `"${action}" must be allow, ask or deny`;
      actions[action] = decision as PolicyDecision;
    }
    layer.actions = actions;
  }
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) return '"rules" must be a list';
    const rules: PolicyRule[] = [];
    for (const rule of raw.rules as Record<string, unknown>[]) {
      if (!rule || !isPolicyAction(rule.action)) return 'Each rule needs a known "action"';
      if (typeof rule.match !== 'string' || !rule.match.trim()) return 'Each rule needs a "match" (a command or domain)';
      if (!POLICY_DECISIONS.includes(rule.decision as PolicyDecision)) return 'Each rule\'s "decision" is allow, ask or deny';
      rules.push({ action: rule.action, match: rule.match, decision: rule.decision as PolicyDecision });
    }
    layer.rules = rules;
  }
  return layer;
}

export type OrgPolicyChangedEvent = KilnEvent<'org_policy.changed', OrgPolicy>;
/** "Always allow" wrote a rule into a Project Policy file (and committed only that file). */
export type ProjectPolicyChangedEvent = KilnEvent<'project_policy.changed', { projectId: string; rule: PolicyRule; commit: string | null }>;
