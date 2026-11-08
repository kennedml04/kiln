// Gates: a Stage marked `gate` holds its Item until a person approves it. When the Stage's Session
// meets its Exit, the Gate raises a blocking Review Ask with the review findings and a diff summary.
// Approving merges the Item's branch into the default branch, removes its worktree and moves it on;
// rejecting (with a comment) sends it back to the last Stage that runs a Session, where a fresh
// Session is seeded with the comment and the findings. A merge that would conflict leaves the
// default branch alone and raises a Decision Ask instead.
import { join, posix } from 'node:path';
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
  type Project,
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
import { branchExists, coAuthoredCommits, coAuthoredFix, commitsAhead, currentBranch, defaultBranch, diffSummary, fileAtHead, folderName, git, isMerged, mergeBranch, mergeConflicts, removeWorktree, worktreePath } from './git.ts';
import { linkedProjectsOf, removeTaskFolder, taskFolder } from './linked.ts';

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
  /** Lets go of the Agents of the Item's finished Sessions, once their processes have exited. */
  release?: (itemId: string) => Promise<void>;
}

export function createGates({ bus, work, asks, dataDir, policy, audit, pullRequests, release }: GatesDeps): Gates {
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

  /** A repo the Item's branch lands in. */
  interface Repo {
    project: Project;
    branch: string;
    base: string;
    client: boolean;
  }

  /**
   * The repos the Item lands in, in landing order: each linked Project the Session touched (its
   * branch has commits past the Project's default branch), then the Item's own Project. A repo the
   * Session never touched, or whose branch has already merged, is not in the list.
   */
  const reposOf = async (item: Item): Promise<Repo[]> => {
    const project = work.project(item.projectId)!;
    const branch = branchOf(item);
    const repos: Repo[] = [];
    if (Object.keys(project.settings.linkedProjects ?? {}).length) {
      for (const link of linkedProjectsOf(work.projects(), project)) {
        if (!(await branchExists(link.project.path, branch))) continue;
        const base = await defaultBranch(link.project.path);
        if ((await commitsAhead(link.project.path, base, branch)) === 0) continue;
        repos.push({ project: link.project, branch, base, client: false });
      }
    }
    repos.push({ project, branch, base: await defaultBranch(project.path), client: true });
    return repos;
  };

  const details = async (item: Item, stage: string, base: string): Promise<ReviewDetails> => {
    const project = work.project(item.projectId)!;
    const branch = branchOf(item);
    const { artifact, path, content } = await artifactOf(item, stage, branch);
    const review: ReviewDetails = { artifact, findings: content, findingsPath: path, diffSummary: await diffSummary(project.path, base, branch), branch, base };
    const repos = await reposOf(item);
    if (repos.length > 1) {
      review.repos = await Promise.all(
        repos.map(async (r) => ({
          projectId: r.project.id,
          name: r.project.name,
          branch: r.branch,
          base: r.client ? base : r.base,
          diffSummary: r.client ? review.diffSummary : await diffSummary(r.project.path, r.base, r.branch),
        })),
      );
    }
    return review;
  };

  const raiseReview = async (item: Item, stage: string, base: string, note?: string) => {
    const review = await details(item, stage, base);
    const stageName = stagesOf(item).find((s) => s.id === stage)?.name ?? stage;
    const byPullRequest = shipsByPullRequest(item, stage);
    const linked = review.repos && review.repos.length > 1 ? review.repos : undefined;
    const names = linked?.map((r) => r.name).join(' and ');
    const ask = asks.raise({
      type: 'review',
      question: linked
        ? `Approve ${item.title} and land it across ${names}?`
        : byPullRequest
          ? `Approve ${item.title} and open a pull request into ${base}?`
          : `Approve ${item.title} and merge it into ${base}?`,
      why: [
        linked
          ? `The ${stageName} Session finished. Approving lands ${review.branch} in ${names}, in that order, each the way its own Project ships (a local merge or a pull request); rejecting sends ${item.title} back with your comment.`
          : byPullRequest
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

  /** The Item's last Stage but one ships it: a `mergeMode: "pr"` Project's Gate there opens a pull request instead of merging. */
  const shipsByPullRequest = (item: Item, gateStage: string, project = work.project(item.projectId)) => {
    if (!pullRequests || project?.settings.mergeMode !== 'pr') return false;
    const stages = stagesOf(item);
    const at = stages.findIndex((s) => s.id === gateStage);
    return at >= 0 && at === stages.length - 2 && !stages[at]!.rollUp;
  };

  /**
   * Approving: lands each repo in order, each by its own Project's merge mode. A local merge that would
   * conflict, or a pull request the Policy wants a person to allow, raises an Ask and stops here; its
   * answer comes back through `land` again, and what already landed is skipped. No local merge happens
   * until every one of them is known to be clean.
   */
  const land = async (item: Item, ask?: Ask) => {
    const stage = ask?.raisedBy.kind === 'gate' ? ask.raisedBy.stage : item.stage;
    const project = work.project(item.projectId)!;
    const repos = await reposOf(item);
    const local = repos.filter((r) => !shipsByPullRequest(item, stage, r.project));
    for (const repo of local) {
      if (await isMerged(repo.project.path, repo.branch, repo.base)) continue;
      const checkedOut = await currentBranch(repo.project.path);
      if (checkedOut !== repo.base) throw new Error(`The Project's checkout is on ${checkedOut ?? 'a detached HEAD'}, not ${repo.base}; Kiln merges only into ${repo.base}`);
      const conflicts = await mergeConflicts(repo.project.path, repo.base, repo.branch);
      if (conflicts.length > 0) {
        const where = repo.client ? repo.base : `${repo.base} in ${repo.project.name}`;
        asks.raise({
          type: 'decision',
          question: `${item.title} conflicts with ${where}. How should it be fixed?`,
          why: `Merging ${repo.branch} into ${where} would conflict in:\n${conflicts.map((f) => `- ${f}`).join('\n')}\nKiln left ${repo.base} as it was.`,
          recommendation: CONFLICT_REBASE,
          options: [CONFLICT_REBASE, CONFLICT_LEAVE],
          blocking: true,
          itemId: item.id,
          raisedBy: { kind: 'gate', stage: item.stage },
          ...(ask?.review ? { review: ask.review } : {}),
        });
        return;
      }
    }
    let commit = '';
    for (const repo of repos) {
      if (!local.includes(repo)) {
        if (pullRequests!.openFor(item.id).some((r) => r.projectId === repo.project.id)) continue;
        if (!(await proposePullRequest(item, repo, ask))) return;
        continue;
      }
      // An earlier answer may have merged and then failed later on: that merge stands, and the rest is done now.
      if (await isMerged(repo.project.path, repo.branch, repo.base)) {
        if (repo.client) commit = (await git(repo.project.path, 'rev-parse', repo.base)).trim();
      } else {
        commit = await mergeBranch(repo.project.path, repo.branch, `Kiln: merge ${item.title} (${repo.branch})`);
      }
    }
    // Pull requests still open keep the Item at its Gate; merging the last one moves it on.
    if (pullRequests?.openFor(item.id).length) return;
    const branch = branchOf(item);
    const base = repos.find((r) => r.client)!.base;
    // The Item's finished Sessions keep their Agent warm for a follow-up message; after the merge none
    // is coming, and an Agent's process working in the worktree would keep it from being removed.
    await release?.(item.id);
    try {
      await removeWorktree(project.path, worktreePath(dataDir, project, item.key), branch);
      for (const repo of repos) {
        if (repo.client) continue;
        await removeWorktree(repo.project.path, join(taskFolder(dataDir, project, item.key), folderName(repo.project.name)), repo.branch).catch(() => undefined);
      }
      await removeTaskFolder(dataDir, project, item.key);
    } catch (err) {
      // The merge is done, so the Item still moves on; its next Stage makes the stale worktree again.
      bus.publish('item.cleanup_failed', { itemId: item.id, projectId: item.projectId, branch, error: err instanceof Error ? err.message : String(err) });
    }
    // The records written in the worktree (a Story's Tickets) are now read from the default branch.
    await work.refresh(project.id);
    const stageDef = stagesOf(item).find((s) => s.id === item.stage);
    // A roll-up Stage holds the Item until its children ship; the roll-up moves it on then.
    work.setGated(item.id, false, { quiet: !stageDef?.rollUp });
    if (!stageDef?.rollUp) await work.advance(item.id);
    bus.publish('item.merged', { itemId: item.id, projectId: item.projectId, branch, into: base, commit, stage: item.stage });
  };

  /** What PR mode writes outside Kiln, as the Policy's `external_writes` details. */
  const pullRequestWrites = (project: Project, branch: string) => {
    const repo = project.settings.github?.repo;
    if (!repo) throw new Error(`PR mode needs the github.repo setting on ${project.name}: the "owner/name" to open pull requests on`);
    const remote = project.settings.github?.remote ?? 'origin';
    return { project, repo, remote, push: `git push ${remote} ${branch}`, pr: `github pr ${repo} ${branch}` };
  };

  const openPullRequest = async (item: Item, repo: Repo, review: ReviewDetails, by: Actor) => {
    const { project, remote, push, pr } = pullRequestWrites(repo.project, repo.branch);
    const target = `item:${item.id}`;
    // As the local merge does: nothing with a Co-Authored-By trailer is pushed towards the default branch.
    const coAuthored = await coAuthoredCommits(project.path, `${repo.base}..${repo.branch}`);
    if (coAuthored.length > 0) throw new Error(`Kiln did not push ${repo.branch}. ${coAuthoredFix(coAuthored)}`);
    try {
      const record = await pullRequests!.open({
        project: { id: project.id, path: project.path, settings: project.settings },
        itemId: item.id,
        key: item.key,
        title: item.title,
        body: [item.description ?? '', review.findings ? `## ${review.artifact ?? REVIEW_FINDINGS}\n\n${review.findings}` : '']
          .filter(Boolean)
          .join('\n\n'),
        branch: repo.branch,
        base: repo.base,
        remote,
      });
      audit?.record({ actor: by, action: 'pr.open', target, outcome: 'allowed', detail: { push, pr, number: record.number, url: record.url } });
    } catch (err) {
      audit?.record({ actor: by, action: 'pr.open', target, outcome: 'failed', detail: { push, pr, error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
  };

  /**
   * Approving a PR-mode repo: that Project's Policy decides whether Kiln may push and propose, or asks
   * first. Returns whether the pull request was opened (false: a person is asked).
   */
  const proposePullRequest = async (item: Item, repo: Repo, ask?: Ask): Promise<boolean> => {
    const review = ask?.review ?? (await details(item, item.stage, (await reposOf(item)).find((r) => r.client)!.base));
    const { project, push, pr } = pullRequestWrites(repo.project, repo.branch);
    const effective = policy!.effective({ project, kind: item.kind, stage: item.stage });
    const decision = strictest(decide(effective, 'external_writes', push), decide(effective, 'external_writes', pr));
    if (decision === 'deny') {
      audit?.record({ actor: { kind: 'kiln' }, action: 'pr.open', target: `item:${item.id}`, outcome: 'refused', detail: { push, pr, by: 'policy' } });
      throw new Error(`The Policy denies writing outside Kiln (${push}; ${pr}), so no pull request was opened`);
    }
    if (decision === 'allow') {
      await openPullRequest(item, repo, review, { kind: 'kiln' });
      return true;
    }
    asks.raise({
      type: 'permission',
      question: `Push and open a pull request: ${push}, then ${pr}?`,
      why: `You approved ${item.title}. ${repo.client ? 'This Project' : repo.project.name} ships through pull requests, and the Policy says to ask before writing outside Kiln. Merging the pull request on GitHub ships it.`,
      recommendation: PERMISSION_ANSWERS.once,
      options: [PERMISSION_ANSWERS.once, PERMISSION_ANSWERS.deny],
      blocking: true,
      itemId: item.id,
      raisedBy: { kind: 'gate', stage: item.stage },
      review: { ...review, projectId: repo.project.id },
    });
    return false;
  };

  /** A pull request merged on GitHub: once none of the Item's are open and nothing waits on a person, its worktree goes and it moves on. */
  pullRequests?.onMerged(async (record) => {
    const item = work.item(record.itemId);
    const project = item && work.project(item.projectId);
    if (!item || !project) return;
    if (pullRequests.openFor(item.id).length > 0 || asks.list({ state: 'open', itemId: item.id }).length > 0) return;
    await release?.(item.id);
    await removeWorktree(project.path, worktreePath(dataDir, project, item.key), record.branch).catch(() => undefined);
    await removeTaskFolder(dataDir, project, item.key).catch(() => undefined);
    work.setGated(item.id, false, { quiet: true });
    await work.advance(item.id);
  });

  /**
   * A pull request was closed on GitHub without merging: the Item goes back to rework, keeping its
   * branch and worktree, and its fresh Session is told why (see reworkSeed).
   */
  pullRequests?.onClosed(async (record) => {
    const item = work.item(record.itemId);
    if (!item || !shipsByPullRequest(item, item.stage, work.project(record.projectId))) return;
    await sendBack(item, item.stage);
  });

  const act = async (ask: Ask) => {
    if (ask.raisedBy.kind !== 'gate') return;
    const gateStage = ask.raisedBy.stage;
    const item = work.item(ask.itemId);
    if (!item || item.stage !== gateStage) return;
    const clientBase = () => defaultBranch(work.project(item.projectId)!.path);
    if (ask.type === 'permission') {
      const base = ask.review?.base ?? (await clientBase());
      if (ask.answer === PERMISSION_ANSWERS.deny) {
        await raiseReview(item, gateStage, base, 'You denied the push and pull request; approve again to be asked again.');
      } else {
        const repo = (await reposOf(item)).find((r) => r.project.id === (ask.review?.projectId ?? item.projectId));
        if (repo) await openPullRequest(item, repo, ask.review ?? (await details(item, gateStage, base)), ask.answeredBy ?? { kind: 'kiln' });
        await land(item, ask);
      }
    } else if (ask.type === 'review') {
      if (ask.answer !== GATE_APPROVE) await sendBack(item, gateStage);
      else await land(item, ask);
    } else if (ask.answer === CONFLICT_REBASE) {
      await sendBack(item, gateStage);
    } else {
      await raiseReview(item, gateStage, ask.review?.base ?? (await clientBase()), 'You said you would fix the conflict yourself; approve again once you have.');
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
      await land(item);
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
