// The pull requests PR-mode Gates open (ticket 24). The Widget that provides the Project's pull
// requests pushes the branch and opens each one; Kiln keeps a record of it, and when the Widget
// reports it merged, the Gate ships the Item; when it reports it closed without merging, the Gate
// sends the Item back to rework.
import type { DatabaseSync } from 'node:sqlite';
import type { OpenedPullRequest, OpenPullRequestRequest, PullRequestRecord, PullRequestState } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import type { WidgetBridge } from '../widgets/bridge.ts';
import { WidgetHostError } from '../widget-host.ts';

type Listener = (record: PullRequestRecord) => Promise<void>;

export interface PullRequests {
  /** Asks the pull-request Widget to push and open one, and records it. */
  open(request: OpenPullRequestRequest): Promise<PullRequestRecord>;
  /** Every open pull request, whoever opened it: their Items wait at their Gates, even over a restart. */
  openAll(): PullRequestRecord[];
  /** The open pull requests this Widget opened. */
  openBy(widgetId: string): PullRequestRecord[];
  /** The Widget says one it opened merged on GitHub; the Gate's listener ships the Item. */
  merged(widgetId: string, projectId: string, number: number): Promise<void>;
  onMerged(listener: Listener): void;
  /** The Widget says one it opened was closed on GitHub without merging; the Gate's listener sends the Item back. */
  closed(widgetId: string, projectId: string, number: number): Promise<void>;
  onClosed(listener: Listener): void;
  /** The Item's pull requests that were closed without merging, oldest first. */
  closedFor(itemId: string): PullRequestRecord[];
}

interface Row {
  item_id: string;
  project_id: string;
  repo: string;
  number: number;
  url: string;
  branch: string;
  widget_id: string;
  state: string;
  opened_at: string;
  closed_at: string | null;
}

const STATES: readonly string[] = ['open', 'merged', 'closed'] satisfies PullRequestState[];

const toRecord = (row: Row): PullRequestRecord => ({
  itemId: row.item_id,
  projectId: row.project_id,
  repo: row.repo,
  number: row.number,
  url: row.url,
  branch: row.branch,
  state: (STATES.includes(row.state) ? row.state : 'open') as PullRequestState,
  openedAt: row.opened_at,
  ...(row.closed_at ? { closedAt: row.closed_at } : {}),
});

/** The only host PR mode knows so far. */
const HOST = 'github';

export function createPullRequests({ db, bus, bridge }: { db: DatabaseSync; bus: EventBus; bridge: WidgetBridge }): PullRequests {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO pull_requests (item_id, project_id, repo, number, url, branch, widget_id, state, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  );
  const openRows = db.prepare(`SELECT * FROM pull_requests WHERE widget_id = ? AND state = 'open' ORDER BY opened_at`);
  const allOpenRows = db.prepare(`SELECT * FROM pull_requests WHERE state = 'open' ORDER BY opened_at`);
  const one = db.prepare('SELECT * FROM pull_requests WHERE project_id = ? AND number = ?');
  const markMerged = db.prepare(`UPDATE pull_requests SET state = 'merged' WHERE project_id = ? AND number = ?`);
  const closedRows = db.prepare(`SELECT * FROM pull_requests WHERE item_id = ? AND state = 'closed' ORDER BY closed_at`);
  const markClosed = db.prepare(`UPDATE pull_requests SET state = 'closed', closed_at = ? WHERE project_id = ? AND number = ?`);
  let onMerge: Listener | undefined;
  let onClose: Listener | undefined;

  /** The record of an open pull request this Widget opened, or undefined once it merged or closed. */
  const ownOpen = (widgetId: string, projectId: string, number: number) => {
    const row = one.get(projectId, number) as unknown as Row | undefined;
    if (!row || row.widget_id !== widgetId) throw new WidgetHostError(404, 'This Widget opened no such pull request');
    return row.state === 'open' ? row : undefined;
  };

  return {
    async open(request) {
      const repo = request.project.settings.github?.repo;
      if (!repo) throw new Error('PR mode needs the github.repo setting: the "owner/name" to open pull requests on');
      const widgetId = bridge.provider('pullRequests', HOST);
      if (!widgetId) throw new Error('No ready Widget opens GitHub pull requests: install and start the GitHub Widget');
      const opened = await bridge.request<OpenedPullRequest>(widgetId, 'pr.open', request);
      const openedAt = new Date().toISOString();
      insert.run(request.itemId, request.project.id, repo, opened.number, opened.url, request.branch, widgetId, openedAt);
      const record = toRecord(one.get(request.project.id, opened.number) as unknown as Row);
      bus.publish('item.pr_opened', { itemId: request.itemId, projectId: request.project.id, number: opened.number, url: opened.url, branch: request.branch });
      return record;
    },
    openAll() {
      return (allOpenRows.all() as unknown as Row[]).map(toRecord);
    },
    openBy(widgetId) {
      return (openRows.all(widgetId) as unknown as Row[]).map(toRecord);
    },
    async merged(widgetId, projectId, number) {
      const row = ownOpen(widgetId, projectId, number);
      if (!row) return;
      markMerged.run(projectId, number);
      const record = { ...toRecord(row), state: 'merged' as const };
      await onMerge?.(record);
      bus.publish('item.pr_merged', { itemId: record.itemId, projectId, number, url: record.url });
    },
    onMerged(next) {
      onMerge = next;
    },
    async closed(widgetId, projectId, number) {
      const row = ownOpen(widgetId, projectId, number);
      if (!row) return;
      const closedAt = new Date().toISOString();
      markClosed.run(closedAt, projectId, number);
      const record = { ...toRecord(row), state: 'closed' as const, closedAt };
      await onClose?.(record);
      bus.publish('item.pr_closed', { itemId: record.itemId, projectId, number, url: record.url });
    },
    onClosed(next) {
      onClose = next;
    },
    closedFor(itemId) {
      return (closedRows.all(itemId) as unknown as Row[]).map(toRecord);
    },
  };
}
