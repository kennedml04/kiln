import type { DragEvent } from 'react';
import type { Item, Project, StoryEntry } from '@kiln/widget-sdk';
import { followLink, itemPath, projectPath } from '../router.ts';
import { ITEM_DRAG_TYPE, stageName } from './ItemCard.tsx';

interface Props {
  entry: StoryEntry;
  items: Record<string, Item>;
  project: Project | undefined;
  /** Show which Project the Story belongs to (on the all-Projects board). */
  showProject?: boolean;
  /** Up next only: drag to reorder, ▲ ▼ to move one place. */
  onMove?: (direction: -1 | 1) => void;
  canMove?: { up: boolean; down: boolean };
}

/** One Story: where it is and how many of its Tickets have shipped, with the Ticket running, waiting or next. */
export function StoryCard({ entry, items, project, showProject, onMove, canMove }: Props) {
  const story = items[entry.storyId];
  if (!story) return null;
  const epic = story.parentId ? items[story.parentId] : undefined;
  const ticket = (id: string | undefined) => (id && id !== entry.storyId ? items[id] : undefined);
  const subRows: { label: string; ticket: Item }[] = [
    ...entry.running.flatMap((id) => ticket(id) ?? []).map((t) => ({ label: 'Running', ticket: t })),
    ...entry.waiting.flatMap((id) => ticket(id) ?? []).map((t) => ({ label: 'Waiting on you', ticket: t })),
  ];
  const next = ticket(entry.next);
  if (!subRows.length && next) subRows.push({ label: 'Next', ticket: next });
  const progress = entry.maintenance
    ? `${entry.shipped} shipped, ${entry.total - entry.shipped} open`
    : entry.total
      ? `${entry.shipped} of ${entry.total} shipped`
      : undefined;
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(ITEM_DRAG_TYPE, entry.storyId);
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <article className="item-card story-card" aria-label={story.title} draggable={Boolean(onMove)} onDragStart={onDragStart}>
      <h4>
        <a href={itemPath(story.id)} onClick={followLink} draggable={false}>
          {story.title}
        </a>
      </h4>
      <p className="item-meta">
        <span className="kind kind-story">{epic ? epic.title : 'Story'}</span>
        <span className="stage">{stageName(project, story)}</span>
        {progress ? <span className="shipped-count">{progress}</span> : null}
        {entry.parked ? <span className="started">Started</span> : null}
      </p>
      {subRows.map(({ label, ticket: t }) => (
        <p key={`${label}${t.id}`} className="story-sub-row">
          <span className="sub-label">{label}</span> {t.title}
          {t.run?.state === 'paused' && t.run.stage === t.stage ? <span className="paused"> Paused</span> : null}
        </p>
      ))}
      {showProject && project ? (
        <a className="item-project" href={projectPath(project.id)} onClick={followLink}>
          {project.name}
        </a>
      ) : null}
      {onMove ? (
        <span className="story-move">
          <button type="button" aria-label={`Move ${story.title} up`} disabled={!canMove?.up} onClick={() => onMove(-1)}>
            ▲
          </button>
          <button type="button" aria-label={`Move ${story.title} down`} disabled={!canMove?.down} onClick={() => onMove(1)}>
            ▼
          </button>
        </span>
      ) : null}
    </article>
  );
}
