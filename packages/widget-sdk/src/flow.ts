// Types for work moving through Stages: Sessions, worktrees, Exits and Project settings.
import type { AgentEvent } from './agent.ts';
import type { KilnEvent } from './index.ts';
import type { SessionUsage } from './budgets.ts';

/**
 * The named Exit checks a Workflow Stage can combine. All but `children_exist` and
 * `no_open_blocking_asks` read the Stage's worktree, so only a Stage with `worktree: true` can use them.
 */
export type ExitCheckId =
  | 'branch_has_commits'
  | 'tree_clean'
  | 'tests_pass'
  | 'findings_exist'
  /** A Story's grill record (`grill.md` beside its record) is committed on its branch. */
  | 'grill_record_exists'
  /** A Story's spec (`spec.md` beside its record) is committed on its branch. */
  | 'spec_exists'
  /** The Item has at least one child Item (a Story's Tickets, made with the create_child_item Kiln tool). */
  | 'children_exist'
  /** Some artifact of the Item (a file in its record's folder, other than the record) is committed on its branch. */
  | 'artifact_exists'
  /** No blocking Ask on the Item is open (whoever raised it). */
  | 'no_open_blocking_asks'
  /**
   * No commit on the branch that is not on its base has a Co-Authored-By trailer. Built in: Kiln
   * checks it on every Stage with a worktree, whether or not the Workflow names it.
   */
  | 'no_coauthor_trailers';

export interface ExitCheckResult {
  id: ExitCheckId;
  /** A person-readable name, e.g. "Tests pass". */
  name: string;
  met: boolean;
  /** Why it is missing (or what was seen), e.g. the failing test output. */
  detail?: string;
}

/** The result of checking a Stage's Exit. Kiln checks it itself; an Agent's reply never counts. */
export interface ExitStatus {
  stage: string;
  met: boolean;
  checks: ExitCheckResult[];
  checkedAt: string;
}

/**
 * `running`: the Agent is working (or was sent Exit feedback and is expected to continue).
 * `waiting`: paused by Kiln until a person answers a blocking Ask it raised; answering resumes it.
 * `finished`: the Agent finished and the Stage's Exit was met (or the Stage has no Exit).
 * `paused`: Kiln interrupted it (Stop all); it keeps its pool slot and continues on resume.
 */
export type SessionState = 'running' | 'paused' | 'waiting' | 'finished' | 'interrupted' | 'stopped' | 'error';

/** One Session: one Agent run on one Item for one Stage. */
export interface SessionInfo {
  id: string;
  itemId: string;
  projectId: string;
  stage: string;
  role: string;
  agentId: string;
  widgetId: string;
  /** The Stage's model, else the Agent's own; unset when neither names one. */
  model?: string;
  /** Absolute path of the Session's worktree, or null when the Stage needs none. */
  worktree: string | null;
  branch: string | null;
  state: SessionState;
  startedAt: string;
  endedAt?: string;
  exit?: ExitStatus;
  /** Live usage, once a turn is reported. */
  usage?: SessionUsage;
}

/** What an Item shows about its latest Session: shown on the Item, carried in `item.updated`. */
export interface ItemRun {
  sessionId: string;
  stage: string;
  state: SessionState;
  worktree: string | null;
  branch: string | null;
  exit?: ExitStatus;
  /** The Session's live usage in its Budget's unit, plus tokens, context size and cap warnings. */
  usage?: SessionUsage;
}

/** `.kiln/settings.json` in the Project's repo (read from the default branch's checkout). */
export interface ProjectSettings {
  /** Run in the Ticket's worktree by the shell; exit code 0 means the tests pass. */
  testCommand?: string;
  /** Commands that count as the Policy's `known_commands` (the test command always does). */
  knownCommands?: string[];
  /** A local-only Project never pushes or opens PRs: its Policy denies external writes. */
  localOnly?: boolean;
  /** How approved work lands: merged into the default branch (default), or pushed as a PR (ticket 24). */
  mergeMode?: 'merge' | 'pr';
  /**
   * Where the Project's Item records live. Default `markdown`, the built-in Tracker; `github` is
   * GitHub Issues, through a ready Widget that provides the `github` Tracker.
   */
  tracker?: TrackerId;
  /** The GitHub repo the Project's issues and pull requests are on (the `github` Tracker, PR mode). */
  github?: GitHubSettings;
  /** The ids of the modules the Project pulls in, in order. Unset: none, today's Workflow. */
  modules?: string[];
}

export type TrackerId = 'markdown' | 'github';

export interface GitHubSettings {
  /** `owner/name`. */
  repo: string;
  /** The git remote PR mode pushes to. Default `origin`. */
  remote?: string;
}

export const PROJECT_SETTINGS_FILE = '.kiln/settings.json';

interface SessionRef {
  sessionId: string;
  itemId: string;
  projectId: string;
}

export type SessionStartedEvent = KilnEvent<'session.started', SessionRef & { session: SessionInfo }>;
/**
 * An Agent event for a Session the Session manager started, published as `session.<kind>`
 * (session.progress, session.usage, session.finished, ...). Events for Sessions the core did not
 * start (test-only commands) stay `agent.<kind>`.
 */
export type SessionAgentEvent<K extends AgentEvent['kind'] = AgentEvent['kind']> = KilnEvent<
  `session.${K}`,
  Extract<AgentEvent, { kind: K }> & SessionRef
>;
/** A message sent into a Session; `from: 'kiln'` is Exit feedback. A person's answer to an Ask carries its `askId`. */
export type SessionMessageEvent = KilnEvent<'session.message', SessionRef & { from: 'kiln' | 'person'; text: string; askId?: string }>;
/** A Session's state changed (e.g. finished -> running again after Exit feedback). */
export type SessionUpdatedEvent = KilnEvent<'session.updated', SessionRef & { session: SessionInfo }>;
export type ExitCheckedEvent = KilnEvent<'exit.checked', SessionRef & { exit: ExitStatus }>;
export type ItemStageChangedEvent = KilnEvent<'item.stage_changed', { itemId: string; projectId: string; from: string; to: string }>;
/**
 * An approved Gate (or a met `mergeOnExit` Exit) merged the Item's branch into the default branch
 * and removed its worktree. `stage` is the Stage whose work was merged.
 */
export type ItemMergedEvent = KilnEvent<'item.merged', { itemId: string; projectId: string; branch: string; into: string; commit: string; stage: string }>;
/**
 * The merge went in but the Item's worktree could not be removed (a process still held it, or it is
 * locked). The Item moves on regardless; the next Session on its branch replaces the stale worktree.
 */
export type ItemCleanupFailedEvent = KilnEvent<'item.cleanup_failed', { itemId: string; projectId: string; branch: string; error: string }>;
/** A rejected Gate whose Stage reworks in place: the Item keeps its Stage and a fresh Session starts there. */
export type ItemReworkEvent = KilnEvent<'item.rework', { itemId: string; projectId: string; stage: string }>;

/** One entry of an Item's Thread (`GET /api/items/:id/thread`): the Session events above, in order. */
export type ThreadEntry = KilnEvent<string, SessionRef & Record<string, unknown>>;
