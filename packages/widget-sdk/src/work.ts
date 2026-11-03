// Work types that cross the core API: Projects, Workflows, Items, the Tracker interface and their events.
import type { KilnEvent } from './index.ts';
import type { ExitCheckId, ItemRun, ProjectSettings, TrackerId } from './flow.ts';
import type { PolicyLayer } from './policy.ts';

/** One step of a Workflow for one Item kind. */
export interface Stage {
  id: string;
  name: string;
  /** A Gate needs a person's approval (a Review Ask) on top of its Exit. */
  gate?: boolean;
  /** The agent role a Session in this Stage runs as. A Stage without one runs no Session. */
  role?: string;
  /** The Agent id that runs this Stage. Unset: the first ready Agent (ticket 09 makes it required). */
  agent?: string;
  model?: string;
  /** The model offered instead when `model`'s Budget runs low (e.g. at the Fable reserve). */
  fallbackModel?: string;
  /** Whether Sessions in this Stage get their own git worktree and branch. */
  worktree?: boolean;
  /** The named checks that make up this Stage's Exit, all of which must be met. */
  exit?: ExitCheckId[];
  /** The Tracker Status written when an Item enters this Stage (e.g. `in-review`). */
  status?: string;
  /** The capacity pool this Stage's Sessions wait for room in. Unset: `agents`. */
  pool?: string;
  /** The Stage Policy: it can only tighten the Org and Project Policy. */
  policy?: PolicyLayer;
  /**
   * A Stage without a Gate whose worktree merges into the default branch as soon as its Exit is met
   * (the Story's Grill). A Gate Stage's worktree merges when the Gate is approved instead.
   */
  mergeOnExit?: boolean;
  /**
   * Where a rejected Gate (or a merge conflict to fix) sends the Item: this Stage's own id reworks it
   * in place. Unset: the last earlier Stage that runs a Session.
   */
  rework?: string;
  /**
   * The Item waits in this Stage for its children, then ships once every child has shipped (and its
   * Gate, if any, was approved). A Story's Tickets, an Epic's Roadmap.
   */
  rollUp?: boolean;
}

/** A type of Item, with the ordered Stages it goes through. */
export interface ItemKind {
  id: string;
  name: string;
  /** The kind this kind's Items hang under (Story under Epic, Ticket under Story). */
  parentKind?: string;
  stages: Stage[];
}

export interface Workflow {
  name: string;
  /** Ordered from the top of the tree down (Epic, Story, Ticket). */
  kinds: ItemKind[];
}

/**
 * Where an Item is in its run, alongside its Stage. The all-Projects board groups by it.
 * `up-next` while it waits in the scheduler's queue, `running` while it has a running (or paused)
 * Session; otherwise `backlog`.
 */
export type RunState = 'backlog' | 'up-next' | 'running' | 'waiting' | 'shipped';

/** A Project's custom Workflow, in its repo (read from the default branch's checkout). */
export const PROJECT_WORKFLOW_FILE = '.kiln/workflow.json';

/** A problem in one of a Project's `.kiln` files, pointing at where it is (e.g. `kinds[0].stages[1].model`). */
export interface ProjectFileError {
  /** Repo-relative path of the file. */
  file: string;
  /** Where in the file, as a JSON path; empty for the file as a whole. */
  at: string;
  message: string;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path of the repository. */
  path: string;
  tracker: TrackerId;
  /** The Workflow in force: the Project's own valid `.kiln/workflow.json`, its last valid one, or the default. */
  workflow: Workflow;
  /** `file` once the Project has had a valid Workflow file; `default` while it uses the shipped one. */
  workflowSource: 'default' | 'file';
  /** The Project settings from `.kiln/settings.json` (empty when it has none). */
  settings: ProjectSettings;
  /** What is wrong with the `.kiln` files right now; empty when they are valid. */
  errors: ProjectFileError[];
  registeredAt: string;
}

/** POST /api/projects */
export interface RegisterProjectRequest {
  path: string;
  name?: string;
}

export interface Item {
  /** Globally unique: `<projectId>/<key>`. */
  id: string;
  projectId: string;
  /** The Tracker's own key for the Item, unique within the Project. */
  key: string;
  kind: string;
  title: string;
  stage: string;
  runState: RunState;
  /** The Tracker's raw Status field, if it has one (for example `ready-for-agent`). */
  status?: string;
  description?: string;
  parentId?: string;
  childIds: string[];
  /** Repo-relative path of the Item's record, for Trackers that keep files. */
  path?: string;
  /** Its latest Session, worktree, branch and Exit status, once one has started. */
  run?: ItemRun;
}

/** POST /api/projects/:id/items */
export interface CreateItemRequest {
  kind: string;
  title: string;
  parentId?: string;
  description?: string;
}

/** What a Tracker knows about one Item. The core adds ids, children and run state. */
export interface TrackerItem {
  key: string;
  kind: string;
  title: string;
  stage: string;
  status?: string;
  description?: string;
  parentKey?: string;
  path?: string;
}

export interface TrackerCreateInput {
  kind: string;
  title: string;
  parentKey?: string;
  description?: string;
  /** The Stage a new record starts in: its kind's first Stage in the Project's Workflow. */
  stage?: string;
  /**
   * Keys already in use in the Project beyond this checkout (the default branch's records and other
   * live worktrees'), so a numbered key is never handed out twice.
   */
  takenKeys?: string[];
}

/** Where a Project's Item records live. The markdown Tracker is built in; others come as Widgets. */
export interface Tracker {
  list(): Promise<TrackerItem[]>;
  /** Calls `onChange` (debounced) whenever records may have changed. Returns an unwatch function. */
  watch(onChange: () => void): () => void;
  /** Writes a new Item record and returns its key. */
  create(input: TrackerCreateInput): Promise<string>;
  /**
   * Records a new Stage (and Status, when given) for an Item. The markdown Tracker writes only
   * those lines, as a Kiln-authored commit on the default branch.
   */
  writeStage(key: string, change: { stage: string; status?: string }, message: string): Promise<void>;
}

/** Sent on every SSE connection, after `core.hello` and any replayed events: the current Work state. */
export type WorkSnapshotEvent = KilnEvent<'work.snapshot', { projects: Project[]; items: Item[] }>;
export type ProjectRegisteredEvent = KilnEvent<'project.registered', { project: Project }>;
/** A Project's `.kiln` files changed: its Workflow, settings or errors. Carries the whole Project. */
export type ProjectUpdatedEvent = KilnEvent<'project.updated', { project: Project }>;
export type ItemCreatedEvent = KilnEvent<'item.created', { item: Item }>;
export type ItemUpdatedEvent = KilnEvent<'item.updated', { item: Item }>;
export type ItemRemovedEvent = KilnEvent<'item.removed', { id: string; projectId: string }>;
