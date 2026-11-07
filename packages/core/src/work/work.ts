// Work: registered Projects and their Items. Projects live in SQLite; Item records live in each
// Project's Tracker, and the core keeps the latest read of them to diff into events.
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateItemRequest,
  Item,
  ItemRun,
  Project,
  RegisterProjectRequest,
  RunState,
  Stage,
  Tracker,
  TrackerItem,
  Workflow,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { DEFAULT_WORKFLOW } from './default-workflow.ts';
import { effectiveWorkflow } from './effective-workflow.ts';
import { createMarkdownTracker } from './markdown-tracker.ts';
import { readProjectFiles, watchProjectFiles } from './project-files.ts';
import { moduleProblems } from './skills.ts';
import { initialiseRepo, repoProblem } from './repo-check.ts';

/** A request the caller got wrong; `status` is the HTTP status to answer with. */
export class WorkError extends Error {
  status: number;
  /** A machine-readable reason sent beside the message (e.g. `not-a-repo`, which the Shell offers to initialise). */
  reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export interface Work {
  /**
   * The id is the name's slug (`-2`, `-3`... when taken) unless the core gives one in `options`
   * (the demo, so each run is a new Project whose old Threads don't come back). It is not offered
   * through the route.
   */
  register(request: RegisterProjectRequest, options?: { id?: string }): Promise<Project>;
  /** Resolves once the Projects stored at core start have read their Items. */
  ready(): Promise<void>;
  /** Runs before a newly registered Project opens (e.g. writing its Project Policy template). */
  onRegister(hook: (project: Project) => void | Promise<void>): void;
  /**
   * Removes a Project from Kiln: the unregister hooks run first (stopping its Sessions, removing its
   * worktrees), then its DB row goes, `item.removed` goes out for each of its Items and
   * `project.removed` last. Its repo folder is left alone; the same folder can be registered again.
   */
  unregister(projectId: string): Promise<void>;
  /** Runs while a Project is being unregistered, before it is gone (e.g. stopping its Sessions). */
  onUnregister(hook: (project: Project) => void | Promise<void>): void;
  projects(): Project[];
  project(id: string): Project | undefined;
  /** Every Item, or one Project's. */
  items(projectId?: string): Item[];
  /**
   * Writes a new Item record through the Project's Tracker. With `checkout` (a Session's worktree)
   * the record is written and committed there instead of the main checkout: it shows on the boards
   * while that worktree is live, and reads from the default branch once the worktree merges.
   */
  createItem(projectId: string, request: CreateItemRequest, options?: { checkout?: string }): Promise<Item>;
  /** Re-reads a Project's Items now (after Kiln wrote records it does not watch, in a worktree or a merge). */
  refresh(projectId: string): Promise<void>;
  /** People never move Items between Stages; only Exits and Gates do. Always throws. */
  moveItem(id: string, stage: string): never;
  item(id: string): Item | undefined;
  /** Records an Item's latest Session (worktree, branch, Exit status) and publishes `item.updated`. */
  setRun(itemId: string, run: ItemRun, options?: { quiet?: boolean }): void;
  /** Marks an Item as waiting in the scheduler's queue (run state Up next), or no longer waiting. */
  setUpNext(itemId: string, waiting: boolean, options?: { quiet?: boolean }): void;
  /**
   * Moves an Item to the next Stage of its kind because its Exit was met: the Tracker records the
   * Stage (and the Stage's Status), then `item.stage_changed` is published. Returns the new Stage.
   */
  advance(itemId: string): Promise<Stage>;
  /**
   * Sets or clears an Item's archived mark (the archive service owns the records) and publishes
   * `item.updated` when the Item exists. The mark is kept for an Item the Tracker doesn't list now.
   */
  setArchived(itemId: string, mark: { at: string; batchId: string } | undefined, options?: { quiet?: boolean }): void;
  /** Marks an Item as waiting on its Gate's Review Ask (run state Waiting), or no longer. */
  setGated(itemId: string, waiting: boolean, options?: { quiet?: boolean }): void;
  /** Moves an Item back to an earlier Stage (a rejected Gate, a merge to redo), recorded like `advance`. */
  sendBack(itemId: string, stageId: string): Promise<Stage>;
  /**
   * Fills in what a Project's stored Workflow leaves open, every time a Project is read (setup's
   * models for the default Workflow's roles). The stored Workflow is not changed.
   */
  decorateWorkflow(decorate: (workflow: Workflow) => Workflow): void;
  close(): void;
}

interface Entry {
  project: Project;
  tracker: Tracker;
  items: Map<string, Item>;
  unwatch: () => void;
  unwatchRecords: () => void;
  refreshing: Promise<void>;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  tracker: string;
  /** The last valid Workflow file's Workflow (only read when `workflow_from_file` is set). */
  workflow: string;
  workflow_from_file: number;
  registered_at: string;
}

type ProjectBase = Pick<Project, 'id' | 'name' | 'path' | 'registeredAt'>;

/**
 * The Project as its `.kiln` files make it now. An invalid Workflow file keeps `last` (the last
 * valid one), or the default when it never had one. No Workflow file means the default, as it ships
 * today: a Project never keeps an old copy of it.
 *
 * The Workflow in force is the effective one: that Workflow with the Project's modules applied. When
 * the modules make it invalid, the Project keeps `previous` (the Workflow it had), else runs without them.
 */
function withFiles(
  base: ProjectBase,
  last: Workflow | undefined,
  previous?: Workflow,
  installedWidgets?: string[],
): Project {
  const files = readProjectFiles(base.path);
  const own = files.workflow ?? (files.hasWorkflowFile ? last : undefined);
  const effective = effectiveWorkflow(own ?? DEFAULT_WORKFLOW, files.modules);
  const failed = Array.isArray(effective);
  const errors = [...files.errors, ...moduleProblems(files.modules, files.settings.modules ?? [], installedWidgets)];
  const project: Project = {
    ...base,
    tracker: files.settings.tracker ?? 'markdown',
    workflow: failed ? (previous ?? own ?? DEFAULT_WORKFLOW) : effective,
    workflowSource: own ? 'file' : 'default',
    settings: files.settings,
    errors: failed ? [...errors, ...effective] : errors,
  };
  if (own) ownWorkflows.set(project, own);
  return project;
}

/** Each Project's own Workflow file's Workflow (before its modules), kept as the last valid one. */
const ownWorkflows = new WeakMap<Project, Workflow>();

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';

const ACTIVE = new Set(['running', 'paused']);

/** Runtime marks the core keeps beside the Tracker's records. */
interface Marks {
  /** Latest Session per Item id (set by the Session manager). */
  runs: Map<string, ItemRun>;
  /** Items waiting in the scheduler's queue (set by the scheduler). */
  upNext: Set<string>;
  /** Items whose Gate waits on a person (set by the Gates). */
  gated: Set<string>;
  /** Items a Reset board archived (kept by the archive service; the Tracker never sees it). */
  archived: Map<string, { at: string; batchId: string }>;
}

/** An Item has shipped once it is in its kind's last Stage. */
const isLastStage = (workflow: Workflow, kind: string, stage: string) => {
  const stages = workflow.kinds.find((k) => k.id === kind)?.stages;
  return stages?.length ? stages[stages.length - 1]!.id === stage : stage === 'shipped';
};

const runStateOf = (workflow: Workflow, kind: string, id: string, stage: string, marks: Marks): RunState => {
  const run = marks.runs.get(id);
  if (isLastStage(workflow, kind, stage)) return 'shipped';
  if (run && ACTIVE.has(run.state) && run.stage === stage) return 'running';
  // Paused by Kiln on a blocking Ask (ticket 06), or waiting on its Gate's Review Ask (ticket 07).
  if ((run?.state === 'waiting' && run.stage === stage) || marks.gated.has(id)) return 'waiting';
  return marks.upNext.has(id) ? 'up-next' : 'backlog';
};

/** Turns a Tracker's records into Items: global ids, children and run state. */
function toItems(project: Project, records: TrackerItem[], marks: Marks): Map<string, Item> {
  const { runs } = marks;
  const id = (key: string) => `${project.id}/${key}`;
  const keys = new Set(records.map((r) => r.key));
  const items = new Map<string, Item>();
  for (const record of records) {
    const parentKey = record.parentKey && keys.has(record.parentKey) ? record.parentKey : undefined;
    items.set(id(record.key), {
      id: id(record.key),
      projectId: project.id,
      key: record.key,
      kind: record.kind,
      title: record.title,
      stage: record.stage,
      runState: runStateOf(project.workflow, record.kind, id(record.key), record.stage, marks),
      status: record.status,
      description: record.description,
      parentId: parentKey ? id(parentKey) : undefined,
      childIds: [],
      path: record.path,
      ...(runs.has(id(record.key)) ? { run: runs.get(id(record.key)) } : {}),
      ...(marks.archived.has(id(record.key)) ? { archived: marks.archived.get(id(record.key))! } : {}),
    });
  }
  for (const item of items.values()) if (item.parentId) items.get(item.parentId)!.childIds.push(item.id);
  return items;
}

export interface WorkOptions {
  /** The Tracker of a Project whose `tracker` setting is not the built-in markdown one (a Widget's). */
  widgetTracker?: (project: () => Project) => Tracker;
  /** The ids of the installed Widgets, so a module that needs a missing one is a Project error. Unset: not checked. */
  installedWidgets?: () => string[];
}

export function createWork(db: DatabaseSync, bus: EventBus, options: WorkOptions = {}): Work {
  const entries = new Map<string, Entry>();
  const registerHooks: ((project: Project) => void | Promise<void>)[] = [];
  const unregisterHooks: ((project: Project) => void | Promise<void>)[] = [];
  const deleteProject = db.prepare('DELETE FROM projects WHERE id = ?');
  const marks: Marks = { runs: new Map(), upNext: new Set(), gated: new Set(), archived: new Map() };
  const projectOf = (base: ProjectBase, last: Workflow | undefined, previous?: Workflow) =>
    withFiles(base, last, previous, options.installedWidgets?.());
  const insertProject = db.prepare(
    'INSERT INTO projects (id, name, path, tracker, workflow, workflow_from_file, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const updateWorkflow = db.prepare('UPDATE projects SET workflow = ?, workflow_from_file = ? WHERE id = ?');
  /** Keeps the last valid Workflow file's Workflow, so a Project keeps it while its file is invalid (even over a restart). */
  const store = (project: Project) => {
    const own = ownWorkflows.get(project);
    updateWorkflow.run(own ? JSON.stringify(own) : '{}', own ? 1 : 0, project.id);
  };
  let decorate = (workflow: Workflow) => workflow;
  const view = (project: Project): Project => {
    const workflow = decorate(project.workflow);
    return workflow === project.workflow ? project : { ...project, workflow };
  };

  /**
   * The Project's records, plus the child records live Sessions wrote in their worktrees (a Story's
   * Tickets before its Gate merges them). The default branch's record wins over a worktree's.
   */
  const records = async (entry: Entry): Promise<TrackerItem[]> => {
    const main = await entry.tracker.list();
    // A Widget's Tracker has no records in worktrees: Sessions write to it directly.
    if (entry.project.tracker !== 'markdown') return main;
    const keys = new Set(main.map((r) => r.key));
    const prefix = `${entry.project.id}/`;
    for (const [itemId, run] of marks.runs) {
      if (!itemId.startsWith(prefix) || !run.worktree || !existsSync(run.worktree)) continue;
      const parentKey = itemId.slice(prefix.length);
      for (const record of await createMarkdownTracker(run.worktree, { workflow: () => entry.project.workflow }).list()) {
        if (record.parentKey !== parentKey || keys.has(record.key)) continue;
        keys.add(record.key);
        main.push(record);
      }
    }
    return main;
  };

  /** Re-reads a Project's Tracker and publishes what changed. Calls queue up, one read at a time. */
  const refresh = (entry: Entry, quiet = false) =>
    (entry.refreshing = entry.refreshing.then(async () => {
      let next: Map<string, Item>;
      try {
        next = toItems(entry.project, await records(entry), marks);
      } catch {
        return; // A half-written file; the watcher fires again when it is complete.
      }
      const previous = entry.items;
      entry.items = next;
      if (quiet) return;
      for (const [id, item] of next) {
        const before = previous.get(id);
        if (!before) bus.publish('item.created', { item });
        else if (JSON.stringify(before) !== JSON.stringify(item)) bus.publish('item.updated', { item });
      }
      for (const id of previous.keys()) {
        if (!next.has(id)) bus.publish('item.removed', { id, projectId: entry.project.id });
      }
    }));

  /** Re-reads the Project's `.kiln` files; when they changed it, publishes `project.updated` and re-reads its Items. */
  const reload = (entry: Entry) => {
    const next = projectOf(entry.project, ownWorkflows.get(entry.project), entry.project.workflow);
    if (JSON.stringify(next) === JSON.stringify(entry.project)) return;
    const trackerChanged = next.tracker !== entry.project.tracker;
    entry.project = next;
    store(next);
    if (trackerChanged) {
      entry.unwatchRecords();
      entry.tracker = trackerOf(entry);
      entry.unwatchRecords = entry.tracker.watch(() => void refresh(entry));
    }
    bus.publish('project.updated', { project: view(next) });
    void refresh(entry);
  };

  const trackerOf = (entry: Entry): Tracker => {
    if (entry.project.tracker === 'markdown') return createMarkdownTracker(entry.project.path, { workflow: () => entry.project.workflow });
    if (!options.widgetTracker) throw new Error(`This core has no ${entry.project.tracker} Tracker`);
    return options.widgetTracker(() => entry.project);
  };

  const open = async (project: Project, quiet: boolean) => {
    const entry: Entry = {
      project,
      tracker: undefined as unknown as Tracker,
      items: new Map(),
      unwatch: () => undefined,
      unwatchRecords: () => undefined,
      refreshing: Promise.resolve(),
    };
    entry.tracker = trackerOf(entry);
    entries.set(project.id, entry);
    await refresh(entry, quiet);
    entry.unwatchRecords = entry.tracker.watch(() => void refresh(entry));
    const unwatchFiles = watchProjectFiles(project.path, () => reload(entry));
    entry.unwatch = () => {
      entry.unwatchRecords();
      unwatchFiles();
    };
    return entry;
  };

  const opening: Promise<unknown>[] = [];
  const rows = db.prepare('SELECT * FROM projects ORDER BY registered_at, id').all() as unknown as ProjectRow[];
  for (const row of rows) {
    const base = { id: row.id, name: row.name, path: row.path, registeredAt: row.registered_at };
    const project = projectOf(base, row.workflow_from_file ? (JSON.parse(row.workflow) as Workflow) : undefined);
    store(project);
    opening.push(open(project, true).catch(() => undefined));
  }
  // A module's needed Widget may have come or gone: the Projects' errors say so at once.
  if (options.installedWidgets) {
    bus.subscribe((event) => {
      if (event.type === 'widget.installed' || event.type === 'widget.removed') for (const e of entries.values()) reload(e);
    });
  }

  const entry = (projectId: string) => {
    const found = entries.get(projectId);
    if (!found) throw new WorkError(404, `No Project "${projectId}"`);
    return found;
  };

  /** Recomputes an Item's run state after a mark changed, publishing `item.updated` if it moved. */
  const remark = (itemId: string, options?: { quiet?: boolean }) => {
    const target = entries.get(itemId.split('/')[0]!);
    const item = target?.items.get(itemId);
    if (!target || !item) return;
    const state = runStateOf(target.project.workflow, item.kind, itemId, item.stage, marks);
    if (state === item.runState) return;
    const next: Item = { ...item, runState: state };
    target.items.set(itemId, next);
    if (!options?.quiet) bus.publish('item.updated', { item: next });
  };

  /** The Tracker records the Item's new Stage (and that Stage's Status), then `item.stage_changed` goes out. */
  const moveTo = async (itemId: string, pick: (stages: Stage[], at: number) => Stage | undefined): Promise<Stage> => {
    const projectId = itemId.split('/')[0]!;
    const target = entry(projectId);
    const item = target.items.get(itemId);
    if (!item) throw new WorkError(404, `No Item "${itemId}"`);
    const stages = target.project.workflow.kinds.find((k) => k.id === item.kind)?.stages ?? [];
    const at = stages.findIndex((s) => s.id === item.stage);
    const next = pick(stages, at);
    if (!next) throw new WorkError(409, `${item.title} is already in its last Stage`);
    const from = stages[at]?.name ?? item.stage;
    await target.tracker.writeStage(item.key, { stage: next.id, status: next.status }, `Kiln: ${item.title} ${from} -> ${next.name}`);
    await refresh(target);
    bus.publish('item.stage_changed', { itemId, projectId, from: item.stage, to: next.id });
    return next;
  };

  return {
    async register(request, options) {
      if (!request || typeof request.path !== 'string' || !request.path) {
        throw new WorkError(400, 'A Project needs the path of its repository');
      }
      const path = resolve(request.path);
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new WorkError(400, `No folder at ${path}`);
      for (const { project } of entries.values()) {
        if (project.path.toLowerCase() === path.toLowerCase()) {
          throw new WorkError(409, `${path} is already registered as "${project.name}"`);
        }
      }
      // Every Project is a git repo, registered at its top, on its default branch, with a commit.
      let problem = await repoProblem(path);
      if (problem?.reason === 'not-a-repo' && request.init === true) {
        try {
          await initialiseRepo(path);
        } catch (err) {
          throw new WorkError(500, `Kiln could not initialise ${path} as a git repo: ${err instanceof Error ? err.message : String(err)}`);
        }
        problem = await repoProblem(path);
      }
      if (problem) throw new WorkError(409, problem.message, problem.reason);
      const name = request.name?.trim() || basename(path);
      let id = options?.id ?? slugify(name);
      if (options?.id !== undefined && entries.has(id)) throw new WorkError(409, `A Project with the id "${id}" is already registered`);
      for (let n = 2; entries.has(id); n++) id = `${slugify(name)}-${n}`;
      const base = { id, name, path, registeredAt: new Date().toISOString() };
      for (const hook of registerHooks) await hook(projectOf(base, undefined));
      // Read after the hooks: they may write Kiln files (the Project Policy template).
      const project = projectOf(base, undefined);
      insertProject.run(id, name, path, project.tracker, '{}', 0, project.registeredAt);
      store(project);
      const opened = await open(project, true);
      bus.publish('project.registered', { project: view(project) });
      for (const item of opened.items.values()) bus.publish('item.created', { item });
      return view(project);
    },
    ready: async () => void (await Promise.all(opening)),
    onRegister(hook) {
      registerHooks.push(hook);
    },
    async unregister(projectId) {
      const target = entry(projectId);
      for (const hook of unregisterHooks) await hook(view(target.project));
      target.unwatch();
      await target.refreshing;
      entries.delete(projectId);
      deleteProject.run(projectId);
      const prefix = `${projectId}/`;
      for (const id of marks.runs.keys()) if (id.startsWith(prefix)) marks.runs.delete(id);
      for (const id of marks.upNext) if (id.startsWith(prefix)) marks.upNext.delete(id);
      for (const id of marks.gated) if (id.startsWith(prefix)) marks.gated.delete(id);
      for (const id of target.items.keys()) bus.publish('item.removed', { id, projectId });
      bus.publish('project.removed', { projectId });
    },
    onUnregister(hook) {
      unregisterHooks.push(hook);
    },
    projects: () => [...entries.values()].map((e) => view(e.project)),
    project: (id) => {
      const found = entries.get(id)?.project;
      return found && view(found);
    },
    decorateWorkflow(next) {
      decorate = next;
    },
    items(projectId) {
      const scope = projectId ? [entry(projectId)] : [...entries.values()];
      return scope.flatMap((e) => [...e.items.values()]);
    },
    async refresh(projectId) {
      await refresh(entry(projectId));
    },
    async createItem(projectId, request, options) {
      const target = entry(projectId);
      const title = typeof request?.title === 'string' ? request.title.trim() : '';
      if (!title) throw new WorkError(400, 'An Item needs a title');
      const kind = target.project.workflow.kinds.find((k) => k.id === request.kind);
      if (!kind) throw new WorkError(400, `The Workflow has no Item kind "${request.kind}"`);
      const parent = request.parentId ? target.items.get(request.parentId) : undefined;
      if (request.parentId && !parent) throw new WorkError(400, `No parent Item "${request.parentId}" in this Project`);
      if (parent && parent.kind !== kind.parentKind) {
        throw new WorkError(400, `A ${kind.name} cannot sit under a ${parent.kind}`);
      }
      if (!parent && kind.parentRequired) {
        const parentName = target.project.workflow.kinds.find((k) => k.id === kind.parentKind)?.name ?? kind.parentKind;
        throw new WorkError(400, `A ${kind.name} needs a ${parentName} as its parent`);
      }
      let key: string;
      try {
        // Only the markdown Tracker keeps records in a worktree; a Widget's writes straight to its Tracker.
        const tracker = options?.checkout && target.project.tracker === 'markdown'
          ? createMarkdownTracker(options.checkout, { workflow: () => target.project.workflow, sessionCheckout: true })
          : target.tracker;
        key = await tracker.create({
          kind: kind.id,
          title,
          parentKey: parent?.key,
          description: request.description,
          stage: kind.stages[0]?.id,
          takenKeys: [...target.items.values()].map((i) => i.key),
        });
      } catch (err) {
        throw new WorkError(409, err instanceof Error ? err.message : String(err));
      }
      await refresh(target);
      const item = target.items.get(`${projectId}/${key}`);
      if (!item) throw new WorkError(500, `The Tracker wrote ${key} but it did not read back`);
      return item;
    },
    moveItem(id) {
      const projectId = id.split('/')[0]!;
      if (!entries.get(projectId)?.items.has(id)) throw new WorkError(404, `No Item "${id}"`);
      throw new WorkError(409, 'Items move to the next Stage only when their Exit is met or a person approves a Gate');
    },
    item: (id) => entries.get(id.split('/')[0]!)?.items.get(id),
    setRun(itemId, run, options) {
      marks.runs.set(itemId, run);
      const target = entries.get(itemId.split('/')[0]!);
      const item = target?.items.get(itemId);
      if (!target || !item) return;
      const next: Item = { ...item, run, runState: runStateOf(target.project.workflow, item.kind, itemId, item.stage, marks) };
      target.items.set(itemId, next);
      if (!options?.quiet) bus.publish('item.updated', { item: next });
    },
    setUpNext(itemId, waiting, options) {
      if (waiting) marks.upNext.add(itemId);
      else marks.upNext.delete(itemId);
      remark(itemId, options);
    },
    setArchived(itemId, mark, options) {
      if (mark) marks.archived.set(itemId, mark);
      else marks.archived.delete(itemId);
      const target = entries.get(itemId.split('/')[0]!);
      const item = target?.items.get(itemId);
      if (!target || !item) return;
      const { archived: _old, ...rest } = item;
      const next: Item = mark ? { ...rest, archived: mark } : rest;
      target.items.set(itemId, next);
      if (!options?.quiet) bus.publish('item.updated', { item: next });
    },
    setGated(itemId, waiting, options) {
      if (waiting) marks.gated.add(itemId);
      else marks.gated.delete(itemId);
      remark(itemId, options);
    },
    advance: (itemId) => moveTo(itemId, (stages, at) => stages[at + 1]),
    sendBack(itemId, stageId) {
      return moveTo(itemId, (stages, at) => {
        const back = stages.findIndex((s) => s.id === stageId);
        if (back === -1 || back >= at) throw new WorkError(409, `"${stageId}" is not an earlier Stage`);
        return stages[back];
      });
    },
    close() {
      for (const e of entries.values()) e.unwatch();
    },
  };
}
