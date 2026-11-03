// Tracker and pull-request Widgets: a Widget whose Manifest provides a Tracker (`provides.trackers`)
// keeps the Item records of every Project whose `tracker` setting names it; one that provides
// `pullRequests` opens the pull requests of PR-mode Projects.
//
// The core asks, down the command stream, with a `widget.request` command; the Widget answers each
// once, with POST /api/widget/replies (body WidgetReply). A request unanswered in 30 s fails.
//
//   op `tracker.list`        payload { project }                 -> TrackerItem[]
//   op `tracker.create`      payload { project, input }          -> { key }
//   op `tracker.writeStage`  payload TrackerWriteStage           -> {}
//   op `pr.open`             payload OpenPullRequestRequest      -> OpenedPullRequest
//
// The Widget tells the core when records may have changed, and when a pull request it opened merged
// or was closed without merging:
//   POST /api/widget/trackers/changed        body { projectId }
//   GET  /api/widget/pull-requests           PullRequestRecord[] it opened that are still open
//   POST /api/widget/pull-requests/merged    body { projectId, number }
//   POST /api/widget/pull-requests/closed    body { projectId, number }
import type { ProjectSettings } from './flow.ts';
import type { KilnEvent } from './index.ts';
import type { TrackerCreateInput } from './work.ts';

/** The Project a request is about. */
export interface TrackerProjectRef {
  id: string;
  /** The repository's checkout. */
  path: string;
  settings: ProjectSettings;
}

export type WidgetRequestOp = 'tracker.list' | 'tracker.create' | 'tracker.writeStage' | 'pr.open';

export interface WidgetRequestCommand {
  type: 'widget.request';
  requestId: string;
  op: WidgetRequestOp;
  payload: unknown;
}

/** POST /api/widget/replies: `result` on success, `error` (a sentence) otherwise. */
export interface WidgetReply {
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface TrackerCreateRequest {
  project: TrackerProjectRef;
  input: TrackerCreateInput;
}

export interface TrackerWriteStage {
  project: TrackerProjectRef;
  key: string;
  stage: string;
  status?: string;
  /** The Stage is its kind's last: the record is done (a GitHub issue closes). */
  closed: boolean;
}

export interface OpenPullRequestRequest {
  project: TrackerProjectRef;
  itemId: string;
  /** The Item's Tracker key. */
  key: string;
  title: string;
  body: string;
  /** Pushed to `remote` first, then proposed for `base`. */
  branch: string;
  base: string;
  remote: string;
}

export interface OpenedPullRequest {
  number: number;
  url: string;
}

/** `closed`: closed on its host without merging. */
export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequestRecord {
  itemId: string;
  projectId: string;
  /** The `github.repo` it is on. */
  repo: string;
  number: number;
  url: string;
  branch: string;
  state: PullRequestState;
  openedAt: string;
  /** When Kiln heard it was closed without merging. */
  closedAt?: string;
}

/** POST /api/widget/trackers/changed */
export interface TrackerChangedRequest {
  projectId: string;
}

/** POST /api/widget/pull-requests/merged, and POST /api/widget/pull-requests/closed */
export interface PullRequestMergedRequest {
  projectId: string;
  number: number;
}

/** A PR-mode Gate's approval pushed the branch and opened a pull request; the Item waits for its merge. */
export type ItemPrOpenedEvent = KilnEvent<'item.pr_opened', { itemId: string; projectId: string; number: number; url: string; branch: string }>;
/** The Item's pull request merged on its host; the Item moved on. */
export type ItemPrMergedEvent = KilnEvent<'item.pr_merged', { itemId: string; projectId: string; number: number; url: string }>;
/** The Item's pull request was closed on its host without merging; the Item went back to rework. */
export type ItemPrClosedEvent = KilnEvent<'item.pr_closed', { itemId: string; projectId: string; number: number; url: string }>;
