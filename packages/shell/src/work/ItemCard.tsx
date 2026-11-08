import { memo, type DragEvent } from 'react';
import type { Item, Project } from '@kiln/widget-sdk';
import { followLink, itemPath, projectPath } from '../router.ts';
import { StoryLine, useStoryOf } from './StoryLine.tsx';
import { UsageLine } from './Usage.tsx';

export const ITEM_DRAG_TYPE = 'application/x-kiln-item';

export const stageName = (project: Project | undefined, item: Item) =>
  project?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === item.stage)?.name ?? item.stage;

/**
 * A Stage with no role runs no Session, so an Item there waits on a person (a module's "Print it" or
 * "Order parts"). Not a roll-up Stage, which waits on children, nor the kind's last Stage: nothing is
 * left to do there.
 */
export const isPersonsMove = (project: Project | undefined, item: Item) => {
  const stages = project?.workflow.kinds.find((k) => k.id === item.kind)?.stages;
  const index = stages?.findIndex((s) => s.id === item.stage) ?? -1;
  if (!stages || index < 0 || index === stages.length - 1) return false;
  const stage = stages[index]!;
  return !stage.role && !stage.rollUp;
};

const kindName =(project: Project | undefined, item: Item) =>
  project?.workflow.kinds.find((k) => k.id === item.kind)?.name ?? item.kind;

interface Props {
  item: Item;
  project: Project | undefined;
  /** Show which Project the Item belongs to (on the all-Projects board). */
  showProject?: boolean;
}

/** One Item. Memoised: an event about another Item leaves this card's props unchanged. */
export const ItemCard = memo(function ItemCard({ item, project, showProject }: Props) {
  const story = useStoryOf(item);
  const onDragStart = (event: DragEvent) => {
    event.dataTransfer.setData(ITEM_DRAG_TYPE, item.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  return (
    <article className="item-card" aria-label={item.title} draggable onDragStart={onDragStart}>
      <h4>
        <a href={itemPath(item.id)} onClick={followLink} draggable={false}>
          {item.title}
        </a>
      </h4>
      <StoryLine story={story} />
      <p className="item-meta">
        <span className={`kind kind-${item.kind}`}>{kindName(project, item)}</span>
        <span className="stage">{stageName(project, item)}</span>
        {isPersonsMove(project, item) ? <span className="your-move">Your move</span> : null}
        {item.status ? <span className="status">{item.status}</span> : null}
        {item.run?.state === 'paused' && item.run.stage === item.stage ? <span className="paused">Paused</span> : null}
        {item.run?.usage && item.run.stage === item.stage ? <UsageLine usage={item.run.usage} /> : null}
      </p>
      {showProject && project ? (
        <a className="item-project" href={projectPath(project.id)} onClick={followLink}>
          {project.name}
        </a>
      ) : null}
    </article>
  );
});
