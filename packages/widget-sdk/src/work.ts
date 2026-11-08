// Work types that cross the core API: Projects, Workflows, Items, the Tracker interface and their events.
import type { KilnEvent } from './index.ts';
import type { ExitCheckId, ItemRun, ProjectSettings, TrackerId } from './flow.ts';
import type { PolicyLayer } from './policy.ts';
import type { RoleMode } from './variants.ts';

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
  /** Local first, cloud only or local only. Unset: local first for the implementer and reviewer, else cloud only. */
  mode?: RoleMode;
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
  /** Every Item of this kind needs a parent (a Ticket always sits under a Story). */
  parentRequired?: boolean;
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

/**
 * POST /api/projects. The folder must be the top of a git work tree, on its default branch, with at
 * least one commit; otherwise it is refused with 409 and the fix, and a `reason`:
 * `not-a-repo`, `not-repo-top`, `no-commits` or `off-default-branch`. Kiln never switches branches.
 */
export interface RegisterProjectRequest {
  path: string;
  name?: string;
  /**
   * Initialise as a git repo: for a folder that isn't one (`not-a-repo`), run `git init -b main` and
   * commit what is there as Kiln, then register it. Ignored for a folder that already is a repo.
   */
  init?: boolean;
}

/**
 * `POST /api/projects/new` (Admin): make `<Projects folder>\<name>`, write a README,
 * `.kiln/settings.json` and a `.gitignore`, `git init -b main` with one commit as Kiln, register the
 * Project and open a grill-stage Story "What we're building" seeded with the description.
 * With no Projects folder set it is refused with 409 and the reason `no-projects-folder`.
 * A step that fails answers with its `step` and leaves the folder in place, unregistered: asking
 * again carries on from there.
 */
export interface NewProjectRequest {
  /** One folder name. */
  name: string;
  /** One line. */
  description: string;
}

/** The steps of New, in order, as a failure names them. */
export type NewProjectStep = 'folder' | 'files' | 'git' | 'register' | 'story';

export interface NewProjectResult {
  project: Project;
  /** The "What we're building" Story, at its first Stage (grill). */
  item: Item;
}

/** Why `POST /api/projects` refused a folder's git state. */
export type RepoRefusal = 'not-a-repo' | 'not-repo-top' | 'no-commits' | 'off-default-branch';

/** One folder in the folder browser. */
export interface FolderEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** It has a `.git`: a git repo (or a worktree of one). */
  git: boolean;
  /** A Project is registered at this folder. */
  registered: boolean;
  /** It has a `.scratch` folder, the markdown Tracker's layout. */
  tracker: boolean;
}

/**
 * `GET /api/fs/folders?path=` (Admin). Without `path`: the browse roots, as `folders`. With one:
 * its child folders, skipping hidden and system folders and junctions (symlinks). A path outside
 * the roots, or reached through a junction, is refused with 403.
 */
export interface FolderListing {
  /** The browse roots: the Projects folder (when set) and the roots set in Settings. A dev instance offers only its data folder. */
  roots: string[];
  /** The folder listed; absent for the roots. */
  path?: string;
  /** The folder one up, while that is still inside a root. */
  parent?: string;
  folders: FolderEntry[];
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
  /** Ids of the Items that must ship before this one starts (a Ticket's `Blocked by`). */
  blockedBy?: string[];
  /** Set on a Project's Maintenance Story, the home of Tickets filed without a Story. */
  maintenance?: true;
  /** Repo-relative path of the Item's record, for Trackers that keep files. */
  path?: string;
  /** Its latest Session, worktree, branch and Exit status, once one has started. */
  run?: ItemRun;
  /** Set when a Reset board archived this (shipped) Item: boards hide it; it is still shipped. */
  archived?: { at: string; batchId: string };
}

/** POST /api/archive/reset */
export interface ArchiveResetRequest {
  /** Only this Project's shipped Items; omitted: every Project. */
  projectId?: string;
}
export interface ArchiveResetResponse {
  batchId: string;
  count: number;
  itemIds: string[];
}

/** POST /api/archive/unarchive: give `batchId` or `itemIds`, not both. */
export interface UnarchiveRequest {
  batchId?: string;
  itemIds?: string[];
}
export interface UnarchiveResponse {
  /** The Items put back. */
  itemIds: string[];
}

/** One Reset, with the Items of it that are still archived. */
export interface ArchiveBatch {
  id: string;
  actor: { id: string; name?: string };
  at: string;
  /** Unset for a Reset of every Project. */
  projectId?: string;
  /** How many Items the Reset archived (some may be unarchived since). */
  count: number;
  items: Item[];
}
export interface ArchiveHistoryResponse {
  batches: ArchiveBatch[];
}

export type ArchiveResetEvent = KilnEvent<'archive.reset', { batchId: string; projectId?: string; count: number }>;
export type ArchiveUnarchivedEvent = KilnEvent<'archive.unarchived', { batchId?: string; itemIds: string[] }>;

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
  /** Keys of the Items that must ship first. Unset: none. */
  blockedByKeys?: string[];
  /** Set on a Project's Maintenance Story. */
  maintenance?: true;
  path?: string;
}

export interface TrackerCreateInput {
  kind: string;
  title: string;
  parentKey?: string;
  description?: string;
  /** The Stage a new record starts in: its kind's first Stage in the Project's Workflow. */
  stage?: string;
  /** A Story that is the Project's Maintenance Story (a Tracker that cannot store the flag may ignore it). */
  maintenance?: boolean;
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
/** A Project was unregistered. Its Items' `item.removed` events go out first; its repo folder is left alone. */
export type ProjectRemovedEvent = KilnEvent<'project.removed', { projectId: string }>;
/** A Project's `.kiln` files changed: its Workflow, settings or errors. Carries the whole Project. */
export type ProjectUpdatedEvent = KilnEvent<'project.updated', { project: Project }>;
export type ItemCreatedEvent = KilnEvent<'item.created', { item: Item }>;
export type ItemUpdatedEvent = KilnEvent<'item.updated', { item: Item }>;
export type ItemRemovedEvent = KilnEvent<'item.removed', { id: string; projectId: string }>;

/** The longest a Story's why line gets, in characters. */
export const STORY_WHY_MAX = 140;

/**
 * The one line of why a Story gives its Tickets: the first sentence of its description, cut to
 * 140 characters with an ellipsis. No description gives nothing.
 */
export function storyWhy(description?: string): string | undefined {
  const text = description?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return sentence.length > STORY_WHY_MAX ? `${sentence.slice(0, STORY_WHY_MAX - 1).trimEnd()}…` : sentence;
}
