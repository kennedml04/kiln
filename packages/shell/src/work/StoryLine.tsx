import { storyWhy, type Item } from '@kiln/widget-sdk';
import { useStore } from '../store.ts';

/** The Story a Ticket belongs to, if the Item is a Ticket with a known parent Story. */
export function useStoryOf(item: Item | undefined): Item | undefined {
  return useStore((s) => (item?.kind === 'ticket' && item.parentId ? s.items[item.parentId] : undefined));
}

/** A Story's title and why line, one line each, ellipsised. Renders nothing without a Story. */
export function StoryLine({ story, withTitle = true }: { story: Item | undefined; withTitle?: boolean }) {
  if (!story) return null;
  const why = storyWhy(story.description);
  return (
    <div className="story-line">
      {withTitle ? <p className="story-line-title">{story.title}</p> : null}
      {why ? <p className="story-line-why">{why}</p> : null}
    </div>
  );
}
