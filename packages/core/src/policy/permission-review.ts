// The Permission review: once an Item merges (a Ticket ships), Kiln looks at the Permission Asks its
// Sessions raised since the last review, groups them by the rule that would have answered them, and
// raises one non-blocking Decision Ask proposing those rules. Nothing changes in the Policy until a
// person answers: "Apply all", "Apply some" (the comment names the rules by number) or "Skip all".
// The chosen rules are one Policy commit. The Ask also warns about any allowed command that kills
// processes by image name, which can stop other Sessions and Kiln itself.
import {
  decide,
  groupByRule,
  isPolicyAction,
  killsByName,
  PERMISSION_ANSWERS,
  PERMISSION_REVIEW_ANSWERS,
  rulePattern,
  type Ask,
  type AuditEntry,
  type Item,
  type ItemMergedEvent,
  type ItemPrMergedEvent,
  type PermissionReview,
  type PolicyAction,
  type ProposedRule,
} from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { AuditLog } from '../audit.ts';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { PolicyEngine, PolicyScope } from './policy.ts';

export interface PermissionReviewDeps {
  bus: EventBus;
  work: Work;
  asks: AskService;
  policy: PolicyEngine;
  audit: AuditLog;
}

const EXAMPLES = 3;

/** The rule numbers an "Apply some" comment names (`1, 3`), or 400 when it names none of them. */
export function chosenRules(comment: string | undefined, count: number): number[] {
  const picked = [...new Set((comment ?? '').match(/\d+/g)?.map(Number) ?? [])].filter((n) => n >= 1 && n <= count);
  if (!picked.length) throw new WorkError(400, `Name the rules to apply by number in the comment, e.g. "1, ${Math.min(2, count)}"`);
  return picked.sort((a, b) => a - b);
}

export function createPermissionReview({ bus, work, asks, policy, audit }: PermissionReviewDeps): void {
  const killWarning = (detail: string, how: string) =>
    `"${detail}" ${how}: it kills processes by image name, which can stop other Sessions' and Kiln's own. Kill only processes you started, by PID.`;

  /** The review of what happened on this Item since its last review, or undefined when there is nothing to propose. */
  const review = (item: Item): PermissionReview | undefined => {
    const project = work.project(item.projectId);
    if (!project) return undefined;
    const all = asks.list({ state: 'all', itemId: item.id });
    const since = all.filter((a) => a.raisedBy.kind === 'permission_review').reduce((last, a) => (a.raisedAt > last ? a.raisedAt : last), '');
    const answered = all.filter(
      (a): a is Ask & { permission: NonNullable<Ask['permission']> } =>
        a.type === 'permission' && a.state === 'answered' && a.permission !== undefined && a.raisedAt > since && isPolicyAction(a.permission.action),
    );
    if (!answered.length) return undefined;
    const scope: PolicyScope = { project, kind: item.kind, stage: item.stage };
    const effective = policy.effective(scope);
    const allowed = (a: Ask) => a.answer !== PERMISSION_ANSWERS.deny;
    const groups = groupByRule(answered.map((a) => ({ askId: a.id, action: a.permission.action as PolicyAction, detail: a.permission.detail, allowed: allowed(a) })));
    const rules: ProposedRule[] = groups
      .filter(
        (g) =>
          g.allAllowed &&
          // A one-off command saved as it stands would rarely come up again.
          (rulePattern(g.action, g.details[0]!) !== undefined || g.askIds.length > 1) &&
          !g.details.some(killsByName) &&
          g.details.some((d) => decide(effective, g.action, d) !== 'allow') &&
          g.details.every((d) => policy.alwaysAllowOffered(scope, g.action, d)),
      )
      .map((g) => ({ action: g.action, match: g.match, asks: g.askIds.length, examples: g.details.slice(0, EXAMPLES) }));
    if (!rules.length) return undefined;
    const warnings = [
      ...answered.filter((a) => allowed(a) && killsByName(a.permission.detail)).map((a) => killWarning(a.permission.detail, `was allowed (${a.answer})`)),
      ...audit
        .query({ action: 'permission.allow', since: since || undefined, limit: 1000 })
        .filter((e: AuditEntry) => e.action === 'permission.allow' && e.target === `item:${item.id}`)
        .map((e) => e.detail as { detail?: string; by?: string } | undefined)
        .map((d) => (d?.by === 'policy' ? d.detail : undefined))
        .filter((d): d is string => typeof d === 'string' && killsByName(d))
        .map((d) => killWarning(d, 'was allowed by the Policy')),
      ...effective.rules.filter((r) => r.decision === 'allow' && killsByName(r.match)).map((r) => killWarning(r.match, 'is allowed by a Policy rule')),
    ];
    return { rules, warnings: [...new Set(warnings)], askIds: answered.map((a) => a.id) };
  };

  const raise = (itemId: string) => {
    const item = work.item(itemId);
    if (!item) return;
    let found: PermissionReview | undefined;
    try {
      found = review(item);
    } catch {
      return; // A malformed Policy file: the Policy page says so, and nothing is proposed.
    }
    if (!found) return;
    const { rules, warnings } = found;
    const listed = rules.map((r, i) => `${i + 1}. ${r.match} (${r.action}, ${r.asks === 1 ? '1 Ask' : `${r.asks} Asks`})`);
    const options = rules.length > 1 ? [PERMISSION_REVIEW_ANSWERS.all, PERMISSION_REVIEW_ANSWERS.some, PERMISSION_REVIEW_ANSWERS.skip] : [PERMISSION_REVIEW_ANSWERS.all, PERMISSION_REVIEW_ANSWERS.skip];
    asks.raise({
      type: 'decision',
      question: `Save ${rules.length === 1 ? 'a Policy rule' : `${rules.length} Policy rules`} for the Permission Asks on "${item.title}"?`,
      why: [
        `These requests were allowed every time they were asked. As Project Policy rules they would be allowed without an Ask from now on; nothing changes until you answer.${rules.length > 1 ? ' To apply some, answer "Apply some" and name them by number in the comment.' : ''}`,
        ...listed,
        ...warnings.map((w) => `Warning: ${w}`),
      ].join('\n'),
      recommendation: PERMISSION_REVIEW_ANSWERS.all,
      options,
      blocking: false,
      itemId: item.id,
      raisedBy: { kind: 'permission_review' },
      permissionReview: found,
    });
  };

  asks.setRecipient('permission_review', {
    reaches: (raiser) => raiser.kind === 'permission_review',
    prepare(ask, answer, by, comment) {
      if (!ask.permissionReview) return;
      // Applied once: a second answer would commit the rules again, or not undo them.
      if (ask.state === 'answered') throw new WorkError(409, 'This Permission review is already answered');
      const { rules } = ask.permissionReview;
      const numbers =
        answer === PERMISSION_REVIEW_ANSWERS.all ? rules.map((_, i) => i + 1) : answer === PERMISSION_REVIEW_ANSWERS.some ? chosenRules(comment, rules.length) : [];
      const project = work.project(ask.projectId);
      if (!project) throw new WorkError(404, 'The Project is gone');
      const chosen = numbers.map((n) => rules[n - 1]!);
      const commit = chosen.length
        ? policy.addRules(project, chosen, `Kiln: Permission review allows ${chosen.length === 1 ? 'one command shape' : `${chosen.length} command shapes`}`)
        : null;
      audit.record({
        actor: by,
        action: 'policy.permission_review',
        target: `item:${ask.itemId}`,
        outcome: 'allowed',
        detail: { askId: ask.id, answer, applied: chosen.map((r) => ({ action: r.action, match: r.match })), commit },
      });
    },
    deliver() {},
  });

  bus.subscribe((event) => {
    if (event.type === 'item.merged') raise((event as ItemMergedEvent).payload.itemId);
    else if (event.type === 'item.pr_merged') raise((event as ItemPrMergedEvent).payload.itemId);
  });
}
