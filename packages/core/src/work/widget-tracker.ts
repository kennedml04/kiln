// A Tracker kept by a Widget (GitHub Issues): every call goes through the request bridge to the
// ready Widget that provides the Project's Tracker. With none ready, reads fail (the board keeps
// the last read) and the Project reads again when one becomes ready.
import type { Project, Tracker, TrackerItem, TrackerProjectRef, TrackerWriteStage, Workflow } from '@kiln/widget-sdk';
import type { WidgetBridge } from '../widgets/bridge.ts';

/** Statuses that mean a record is done, whatever Stage it names. */
const DONE_STATUSES = new Set(['done', 'shipped', 'closed']);

/** A Stage the record's kind does not have reads as its first Stage, or its last once it is done. */
function settle(records: TrackerItem[], workflow: Workflow): TrackerItem[] {
  return records.map((record) => {
    const stages = workflow.kinds.find((k) => k.id === record.kind)?.stages;
    if (!stages?.length || stages.some((s) => s.id === record.stage)) return record;
    const done = record.stage === 'shipped' || DONE_STATUSES.has(record.status?.toLowerCase() ?? '');
    return { ...record, stage: (done ? stages[stages.length - 1]! : stages[0]!).id };
  });
}

export const projectRef = (project: Project): TrackerProjectRef => ({ id: project.id, path: project.path, settings: project.settings });

export function createWidgetTracker(bridge: WidgetBridge, project: () => Project): Tracker {
  const provider = () => {
    const { tracker } = project();
    const id = bridge.provider('trackers', tracker);
    if (!id) throw new Error(`No ready Widget provides the ${tracker} Tracker`);
    return id;
  };
  /** Each record's kind, from the last read, to tell when a Stage is its kind's last. */
  const kinds = new Map<string, string>();
  const isLast = (key: string, stage: string) => {
    const stages = project().workflow.kinds.find((k) => k.id === kinds.get(key))?.stages ?? [];
    return stages.at(-1)?.id === stage;
  };

  return {
    async list() {
      const records = settle(await bridge.request<TrackerItem[]>(provider(), 'tracker.list', { project: projectRef(project()) }), project().workflow);
      for (const record of records) kinds.set(record.key, record.kind);
      return records;
    },
    watch(onChange) {
      const { id } = project();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = bridge.onChanged((projectId) => {
        if (projectId !== undefined && projectId !== id) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 50);
      });
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    },
    async create(input) {
      const { key } = await bridge.request<{ key: string }>(provider(), 'tracker.create', { project: projectRef(project()), input });
      return key;
    },
    async writeStage(key, change) {
      const payload: TrackerWriteStage = {
        project: projectRef(project()),
        key,
        stage: change.stage,
        ...(change.status !== undefined ? { status: change.status } : {}),
        closed: isLast(key, change.stage),
      };
      await bridge.request(provider(), 'tracker.writeStage', payload);
    },
  };
}
