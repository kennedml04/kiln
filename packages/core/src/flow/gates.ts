// Gates: a Stage marked `gate` holds its Item until a person approves it. When the Stage's Session
// meets its Exit, the Gate raises a blocking Review Ask with the review findings and a diff summary.
// Approving merges the Item's branch into the default branch, removes its worktree and moves it on;
// rejecting (with a comment) sends it back to the last Stage that runs a Session, where a fresh
// Session is seeded with the comment and the findings. A merge that would conflict leaves the
// default branch alone and raises a Decision Ask instead.
import { posix } from 'node:path';
import {
  CONFLICT_LEAVE,
  CONFLICT_REBASE,
  GATE_APPROVE,
  GATE_REJECT,
  PERMISSION_ANSWERS,
  decide,
  strictest,
  type Actor,
  type Ask,
  type Item,
  type ReviewDetails,
  type SessionInfo,
  type Stage,
} from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { AuditLog } from '../audit.ts';
import type { PolicyEngine } from '../policy/policy.ts';
import type { PullRequests } from './pull-requests.ts';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from '../work/work.ts';
import { specPathOf } from './exit-checker.ts';
import { currentBranch, defaultBranch, diffSummary, fileAtHead, mergeBranch, mergeConflicts, removeWorktree, worktreePath } from './git.ts';

export interface Gates {
  /** The Gate's Stage Session met its Exit: raise the Review Ask and hold the Item until a person answers. */
  raise(session: SessionInfo, base: string): Promise<Ask>;
  /**
   * What a fresh Session on a sent-back Item starts with: the comment and findings of the Review
   * it failed, or the merge conflict to fix. Only Gate answers given after `since` (the Item's
   * previous Session start) count.
   */
  reworkSeed(itemId: string, since: string | undefined): { name: string; content: string }[];
  /**
   * A `mergeOnExit` Stage's Session met its Exit: merge its branch into the default branch, remove
   * its worktree and move the Item on. A conflict raises the Decision Ask, as at a Gate.
   */
  mergeOnExit(session: SessionInfo): Promise<void>;
}

/**
 * Where a Ticket's review findings go: `<story>/reviews/<ticket file>` beside its `issues/` folder.
 * An Item with no file (one kept in GitHub Issues) has them at `.scratch/reviews/<key>.md`.
 */
export function findingsPathOf(item: Pick<Item, 'path' | 'key'>): string {
  if (!item.path) return `.scratch/reviews/${item.key.replace(/[\\/]+/g, '-')}.md`;
  return posix.join(posix.dirname(posix.dirname(item.path)), 'reviews', posix.basename(item.path));
}

export const REVIEW_COMMENT = 'Review comment';
export const REVIEW_FINDINGS = 'Review findings';
export const MERGE_CONFLICT = 'Merge conflict';
export const PULL_REQUEST_CLOSED = 'Pull request closed';

export interface GatesDeps {
  bus: EventBus;
  work: Work;
  asks: AskService;
  dataDir: string;
  /** PR mode (ticket 24): without these, every Gate merges locally. */
  policy?: PolicyEngine;
  audit?: AuditLog;
  pullRequests?: PullRequests;
}

export function createGates({ bus, work, asks, dataDir, policy, audit, pullRequests }: GatesDeps): Gates {
  /** Answers are acted on one at a time per Item. */
  const chains = new Map<string, Promise<void>>();

  const stagesOf = (item: Item): Stage[] => work.project(item.projectId)?.workflow.kinds.find((k) => k.id === item.kind)?.stages ?? [];

  /**
   * The Stage a rejected Item goes back to: the Gate Stage's `rework` (which may be itself), else the
   * last Stage before the Gate that runs a Session.
   */
  const reworkStage = (item: Item, gateStage: string): Stage | undefined => {
    const stages = stagesOf(item);
    const at = stages.findIndex((s) => s.id === gateStage);
    const named = stages[at]?.rework;
    if (named) return stages.find((s) => s.id === named);
    return stages.slice(0, Math.max(at, 0)).reverse().find((s) => s.role);
  };

  const branchOf = (item: Item) => item.run?.branch ?? `kiln/${item.key}`;

  /** What the Gate shows, by what its Stage's Exit asked for: the spec, the Ticket list, or review findings. */
  const artifactOf = async (item: Item, stage: string, branch: string) => {
    const project = work.project(item.projectId)!;
    const exit = stagesOf(item).find((s) => s.id === stage)?.exit ?? [];
    if (exit.includes('spec_exists') && item.path) {
      const path = specPathOf(posix.dirname(item.path));
      return { artifact: 'Spec', path, content: (await fileAtHead(project.path, path, branch)) || '(The Session wrote no spec.)' };
    }
    if (exit.includes('children_exist')) {
      const children = item.childIds.map((id) => work.item(id)).filter((child) => child !== undefined);
      const list = children.map((child) => `- ${child.title}${child.description ? `: ${child.description}` : ''}`).join('\n');
      return { artifact: 'Tickets', path: '', content: list || '(The Session created no Tickets.)' };
    }
    const path = findingsPathOf(item);
    return {
      artifact: REVIEW_FINDINGS,
      path,
      content: (path && (await fileAtHead(project.path, path, branch))) || '(The review Session wrote no findings.)',
    };
  };

  const details = async (item: Item, stage: string, base: string): Promise<ReviewDetails> => {
    const project = work.project(item.projectId)!;
    const branch = branchOf(item);
    const { artifact, path, content } = await artifactOf(item, stage, branch);
    return { artifact, findings: content, findingsPath: path, diffSummary: await diffSummary(project.path, base, branch), branch, base };
  };

  const raiseReview = async (item: Item, stage: string, base: string, note?: string) => {
    const review = await details(item, stage, base);
    const stageName = stagesOf(item).find((s) => s.id === stage)?.name ?? stage;
    const byPullRequest = shipsByPullRequest(item, stage);
    const ask = asks.raise({
      type: 'review',
      question: byPullRequest ? `Approve ${item.title} and open a pull request into ${base}?` : `Approve ${item.title} and merge it into ${base}?`,
      why: [
        byPullRequest
          ? `The ${stageName} Session finished. Approving pushes ${review.branch} and opens a pull request into ${base}; merging it on GitHub ships ${item.title}. Rejecting sends it back with your comment.`
          : `The ${stageName} Session finished. Approving merges ${review.branch} into ${base} and moves ${item.title} on; rejecting sends it back with your comment.`,
        note ?? '',
      ]
        .filter(Boolean)
        .join('\n'),
      recommendation: GATE_APPROVE,
      options: [GATE_APPROVE, GATE_REJECT],
      blocking: true,
      itemId: item.id,
      raisedBy: { kind: 'gate', stage },
      review,
    });
    work.setGated(item.id, true);
    return ask;
  };

  const sendBack = async (item: Item, gateStage: string) => {
    const to = reworkStage(item, gateStage);
    if (!to) throw new WorkError(409, `${item.title} has no earlier Stage to go back to`);
    if (to.id === gateStage) {
      // Reworked in place: the Item keeps its Stage and its worktree, and a fresh Session starts there.
      work.setGated(item.id, false);
      bus.publish('item.rework', { itemId: item.id, projectId: item.projectId, stage: to.id });
      return;
    }
    work.setGated(item.id, false, { quiet: true });
    await work.sendBack(item.id, to.id);
  };

  const merge = async (item: Item, ask?: Ask) => {
    const project = work.project(item.projectId)!;
    const base = await defaultBranch(project.path);
    const branch = ask?.review?.branch ?? branchOf(item);
    const checkedOut = await currentBranch(project.path);
    if (checkedOut !== base) throw new Error(`The Project's checkout is on ${checkedOut ?? 'a detached HEAD'}, not ${base}; Kiln merges only into ${base}`);
    const conflicts = await mergeConflicts(project.path, base, branch);
    if (conflicts.length > 0) {
      asks.raise({
        type: 'decision',
        question: `${item.title} conflicts with ${base}. How should it be fixed?`,
        why: `Merging ${branch} into ${base} would conflict in:\n${conflicts.map((f) => `- ${f}`).join('\n')}\nKiln left ${base} as it was.`,
        recommendation: CONFLICT_REBASE,
        options: [CONFLICT_REBASE, CONFLICT_LEAVE],
        blocking: true,
        itemId: item.id,
        raisedBy: { kind: 'gate', stage: item.stage },
        ...(ask?.review ? { review: ask.review } : {}),
      });
      return;
    }
    const commit = await mergeBranch(project.path, branch, `Kiln: merge ${item.title} (${branch})`);
    await removeWorktree(project.path, worktreePath(dataDir, project.id, item.key), branch);
    // The records written in the worktree (a Story's Tickets) are now read from the default branch.
    await work.refresh(project.id);
    const stage = stagesOf(item).find((s) => s.id === item.stage);
    // A roll-up Stage holds the Item until its children ship; the roll-up moves it on then.
    work.setGated(item.id, false, { quiet: !stage?.rollUp });
    if (!stage?.rollUp) await work.advance(item.id);
    bus.publish('item.merged', { itemId: item.id, projectId: item.projectId, branch, into: base, commit, stage: item.stage });
  };

  /**
   * PR mode: a `mergeMode: "pr"` Project's Gate that ships its Item (the next Stage is its kind's
   * last) opens a pull request instead of merging locally.
   */
  const shipsByPullRequest = (item: Item, gateStage: string) => {
    if (!pullRequests || work.project(item.projectId)?.settings.mergeMode !== 'pr') return false;
    const stages = stagesOf(item);
    const at = stages.findIndex((s) => s.id === gateStage);
    return at >= 0 && at === stages.length - 2 && !stages[at]!.rollUp;
  };

  /** What PR mode writes outside Kiln, as the Policy's `external_writes` details. */
  const pullRequestWrites = (item: Item, branch: string) => {
    const project = work.project(item.projectId)!;
    const repo = project.settings.github?.repo;
    if (!repo) throw new Error('PR mode needs the github.repo setting: the "owner/name" to open pull requests on');
    const remote = project.settings.github?.remote ?? 'origin';
    return { project, repo, remote, push: `git push ${remote} ${branch}`, pr: `github pr ${repo} ${branch}` };
  };

  const openPullRequest = async (item: Item, review: ReviewDetails, by: Actor) => {
    const { project, remote, push, pr } = pullRequestWrites(item, review.branch);
    const target = `item:${item.id}`;
    try {
      const record = await pullRequests!.open({
        project: { id: project.id, path: project.path, settings: project.settings },
        itemId: item.id,
        key: item.key,
        title: item.title,
        body: [item.description ?? '', review.findings ? `## ${review.artifact ?? REVIEW_FINDINGS}\n\n${review.findings}` : '']
          .filter(Boolean)
          .join('\n\n'),
        branch: review.branch,
        base: review.base,
        remote,
      });
      audit?.record({ actor: by, action: 'pr.open', target, outcome: 'allowed', detail: { push, pr, number: record.number, url: record.url } });
    } catch (err) {
      audit?.record({ actor: by, action: 'pr.open', target, outcome: 'failed', detail: { push, pr, error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  };

  /** Approving a PR-mode Gate: the Policy decides whether Kiln may push and propose, or asks first. */
  const proposePullRequest = async (item: Item, ask: Ask) => {
    const review = ask.review ?? (await details(item, ask.raisedBy.kind === 'gate' ? ask.raisedBy.stage : item.stage, await defaultBranch(work.project(item.projectId)!.path)));
    const { project, push, pr } = pullRequestWrites(item, review.branch);
    const effective = policy!.effective({ project, kind: item.kind, stage: item.stage });
    const decision = strictest(decide(effective, 'external_writes', push), decide(effective, 'external_writes', pr));
    if (decision === 'deny') {
      audit?.record({ actor: { kind: 'kiln' }, action: 'pr.open', target: `item:${item.id}`, outcome: 'refused', detail: { push, pr, by: 'policy' } });
      throw new Error(`The Policy denies writing outside Kiln (${push}; ${pr}), so no pull request was opened`);
    }
    if (decision === 'allow') return openPullRequest(item, review, { kind: 'kiln' });
    asks.raise({
      type: 'permission',
      question: `Push and open a pull request: ${push}, then ${pr}?`,
      why: `You approved ${item.title}. This Project ships through pull requests, and the Policy says to ask before writing outside Kiln. Merging the pull request on GitHub ships it.`,
      recommendation: PERMISSION_ANSWERS.once,
      options: [PERMISSION_ANSWERS.once, PERMISSION_ANSWERS.deny],
      blocking: true,
      itemId: item.id,
      raisedBy: { kind: 'gate', stage: item.stage },
      review,
    });
  };

  /** The pull request merged on GitHub: the branch's worktree goes and the Item moves on. */
  pullRequests?.onMerged(async (record) => {
    const item = work.item(record.itemId);
    const project = work.project(record.projectId);
    if (!item || !project) return;
    await removeWorktree(project.path, worktreePath(dataDir, project.id, item.key), record.branch).catch(() => undefined);
    work.setGated(item.id, false, { quiet: true });
    await work.advance(item.id);
  });

  /**
   * The pull request was closed on GitHub without merging: the Item goes back to rework, keeping its
   * branch and worktree, and its fresh Session is told why (see reworkSeed).
   */
  pullRequests?.onClosed(async (record) => {
    const item = work.item(record.itemId);
    if (!item || !shipsByPullRequest(item, item.stage)) return;
    await sendBack(item, item.stage);
  });

  const act = async (ask: Ask) => {
    if (ask.raisedBy.kind !== 'gate') return;
    const gateStage = ask.raisedBy.stage;
    const item = work.item(ask.itemId);
    if (!item || item.stage !== gateStage) return;
    if (ask.type === 'permission') {
      const base = ask.review?.base ?? (await defaultBranch(work.project(item.projectId)!.path));
      if (ask.answer === PERMISSION_ANSWERS.deny) {
        await raiseReview(item, gateStage, base, 'You denied the push and pull request; approve again to be asked again.');
      } else await openPullRequest(item, ask.review ?? (await details(item, gateStage, base)), ask.answeredBy ?? { kind: 'kiln' });
    } else if (ask.type === 'review') {
      if (ask.answer !== GATE_APPROVE) await sendBack(item, gateStage);
      else if (shipsByPullRequest(item, gateStage)) await proposePullRequest(item, ask);
      else await merge(item, ask);
    } else if (ask.answer === CONFLICT_REBASE) {
      await sendBack(item, gateStage);
    } else {
      await raiseReview(item, gateStage, ask.review?.base ?? (await defaultBranch(work.project(item.projectId)!.path)), 'You said you would fix the conflict yourself; approve again once you have.');
    }
  };

  asks.setRecipient('gate', {
    // A Gate never goes away; whether its Item is still at the Gate is checked when an answer comes.
    reaches: (raiser) => raiser.kind === 'gate',
    prepare(ask, answer, _by, comment) {
      const item = work.item(ask.itemId);
      if (ask.raisedBy.kind === 'gate' && item && item.stage !== ask.raisedBy.stage) {
        throw new WorkError(409, `${item.title} is no longer at this Gate`);
      }
      if (ask.type === 'review' && answer === GATE_REJECT && !comment) {
        throw new WorkError(400, 'Say what needs changing: a rejection needs a comment');
      }
    },
    deliver(ask) {
      const before = chains.get(ask.itemId) ?? Promise.resolve();
      const next = before
        .then(() => act(ask))
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          bus.publish('gate.failed', { itemId: ask.itemId, projectId: ask.projectId, askId: ask.id, error: message });
          // Keep the Item at its Gate with an open Ask, so the person can try again.
          const item = work.item(ask.itemId);
          if (item && ask.raisedBy.kind === 'gate' && item.stage === ask.raisedBy.stage && ask.review) {
            await raiseReview(item, ask.raisedBy.stage, ask.review.base, `Kiln could not act on the last answer: ${message}`).catch(() => undefined);
          }
        });
      chains.set(ask.itemId, next);
    },
  });

  // Items whose Gate was still waiting when the core last stopped are still waiting.
  for (const ask of asks.list()) if (ask.raisedBy.kind === 'gate') work.setGated(ask.itemId, true, { quiet: true });
  // So are Items whose pull request was still open: they wait for it to merge or close.
  for (const record of pullRequests?.openAll() ?? []) work.setGated(record.itemId, true, { quiet: true });

  return {
    async raise(session, base) {
      const item = work.item(session.itemId);
      if (!item) throw new WorkError(404, `No Item "${session.itemId}"`);
      return raiseReview(item, session.stage, base);
    },
    async mergeOnExit(session) {
      const item = work.item(session.itemId);
      if (!item) throw new WorkError(404, `No Item "${session.itemId}"`);
      await merge(item);
    },
    reworkSeed(itemId, since) {
      const answered = asks
        .list({ state: 'answered', itemId })
        .filter((a) => a.raisedBy.kind === 'gate' && a.answeredAt && (!since || a.answeredAt > since))
        .sort((a, b) => (a.answeredAt! < b.answeredAt! ? -1 : 1));
      const last = answered.at(-1);
      const closed = pullRequests?.closedFor(itemId).filter((r) => r.closedAt && (!since || r.closedAt > since)).at(-1);
      if (closed && (!last || closed.closedAt! > last.answeredAt!)) {
        return [
          {
            name: PULL_REQUEST_CLOSED,
            content: `Pull request #${closed.number} was closed on GitHub without merging (${closed.url}). Find out why on the pull request, change ${closed.branch} to address it, run the tests and commit.`,
          },
        ];
      }
      if (!last) return [];
      if (last.type === 'review' && last.answer === GATE_REJECT) {
        return [
          { name: REVIEW_COMMENT, content: last.comment ?? '' },
          ...(last.review ? [{ name: last.review.artifact ?? REVIEW_FINDINGS, content: last.review.findings }] : []),
        ];
      }
      if (last.type === 'decision' && last.answer === CONFLICT_REBASE) {
        const base = last.review?.base ?? 'the default branch';
        return [
          {
            name: MERGE_CONFLICT,
            content: `${last.why}\nRebase this branch onto ${base}, resolve the conflicts, run the tests and commit.`,
          },
        ];
      }
      return [];
    },
  };
}
