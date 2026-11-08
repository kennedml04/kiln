import { useMemo, useState, type DragEvent } from 'react';
import type { Item, Project, RunState, StoryEntry } from '@kiln/widget-sdk';
import { followLink, projectPath } from '../router.ts';
import { api, useStore } from '../store.ts';
import { BoardMenu } from './BoardMenu.tsx';
import { DemoControls, useDemo } from './Demo.tsx';
import { ImportProject } from './ImportProject.tsx';
import { ITEM_DRAG_TYPE, ItemCard } from './ItemCard.tsx';
import { NewProject } from './NewProject.tsx';
import { StoryCard } from './StoryCard.tsx';

const RUN_STATES: { id: RunState; name: string }[] = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'up-next', name: 'Up next' },
  { id: 'running', name: 'Running' },
  { id: 'waiting', name: 'Waiting' },
  { id: 'shipped', name: 'Shipped recently' },
];

/** The board's + Project button: make a New Project, or Import an existing folder as one. */
function AddProject() {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-project">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        + Project
      </button>
      {open ? (
        <section aria-label="Add a Project">
          <h3>New</h3>
          <NewProject onDone={() => setOpen(false)} />
          <h3>Import</h3>
          <ImportProject onDone={() => setOpen(false)} />
        </section>
      ) : null}
    </div>
  );
}

/** The Stories Up next lists: work waiting and nothing running. A Project's board passes its own. */
export function upNextStories(stories: StoryEntry[], items: Record<string, Item>, projectId?: string) {
  return stories.filter(
    (e) =>
      (!projectId || e.projectId === projectId) &&
      !e.running.length &&
      Boolean(e.next || items[e.storyId]?.runState === 'up-next'),
  );
}

/** Up next in Story order. Dropping a Story on another moves it just before that one; ▲ ▼ move it one place. */
export function UpNext({ stories, projects, projectId }: { stories: StoryEntry[]; projects: Record<string, Project>; projectId?: string }) {
  const items = useStore((s) => s.items);
  const [error, setError] = useState<string>();
  const ids = stories.map((e) => e.storyId);
  const send = async (order: string[]) => {
    setError(undefined);
    try {
      await api('PUT', '/api/scheduler/queue', projectId ? { order, projectId } : { order });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(ITEM_DRAG_TYPE)) event.preventDefault();
  };
  const dropBefore = (targetId: string | undefined) => async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(ITEM_DRAG_TYPE);
    if (!id || id === targetId || !ids.includes(id)) return;
    const order = ids.filter((i) => i !== id);
    const at = targetId ? order.indexOf(targetId) : order.length;
    order.splice(at < 0 ? order.length : at, 0, id);
    await send(order);
  };
  const move = (index: number) => (direction: -1 | 1) => {
    const order = [...ids];
    [order[index], order[index + direction]] = [order[index + direction]!, order[index]!];
    return send(order);
  };
  return (
    <section className="column" aria-label="Up next" onDragOver={onDragOver} onDrop={dropBefore(undefined)}>
      <h3>
        Up next <span className="count">{stories.length}</span>
      </h3>
      {stories.map((entry, i) => (
        <div key={entry.storyId} onDragOver={onDragOver} onDrop={dropBefore(entry.storyId)}>
          <StoryCard
            entry={entry}
            items={items}
            project={projects[entry.projectId]}
            showProject={!projectId}
            onMove={move(i)}
            canMove={{ up: i > 0, down: i < stories.length - 1 }}
          />
        </div>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

/** Home: every Project's Items, grouped by run state. */
export function HomeBoard() {
  const projects = useStore((s) => s.projects);
  const items = useStore((s) => s.items);
  const stories = useStore((s) => s.scheduler?.stories);
  const demo = useDemo();
  const columns = useMemo(() => {
    const grouped = new Map<RunState, Item[]>(RUN_STATES.map((r) => [r.id, []]));
    const isMaintenanceTicket = (i: Item) => i.kind === 'ticket' && Boolean(i.parentId && items[i.parentId]?.maintenance);
    for (const item of Object.values(items)) {
      if (item.archived) continue;
      // Stories stand for their Tickets in Up next and Running; Tickets show on their own only in Backlog,
      // Waiting, and Shipped for Maintenance.
      if (item.runState === 'up-next' && (item.kind === 'story' || item.kind === 'ticket')) continue;
      if (item.runState === 'running' && (item.kind === 'story' || item.kind === 'ticket')) continue;
      if (item.runState === 'shipped' && item.kind === 'ticket' && !isMaintenanceTicket(item)) continue;
      grouped.get(item.runState)?.push(item);
    }
    return grouped;
  }, [items]);
  const runningStories = (stories ?? []).filter((e) => e.running.length);
  const upNext = upNextStories(stories ?? [], items);
  const projectList = Object.values(projects);

  return (
    <>
      <div className="board-toolbar" role="toolbar" aria-label="Board">
        <h2>Board</h2>
        <BoardMenu />
      </div>
      <section className="projects" aria-label="Projects">
        <h2>Projects</h2>
        {projectList.length ? (
          <ul>
            {projectList.map((p) => (
              <li key={p.id}>
                <a href={projectPath(p.id)} onClick={followLink}>
                  {p.name}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No Projects yet. Import a repository with + Project to see its Items.</p>
        )}
        <AddProject />
        {demo?.available && !demo.projectId ? <DemoControls state={demo} action="Add the demo" /> : null}
      </section>
      <div className="board">
        {RUN_STATES.map((runState) =>
          runState.id === 'up-next' ? (
            <UpNext key={runState.id} stories={upNext} projects={projects} />
          ) : (
            <section key={runState.id} className="column" aria-label={runState.name}>
              <h3>
                {runState.name}{' '}
                <span className="count">{columns.get(runState.id)!.length + (runState.id === 'running' ? runningStories.length : 0)}</span>
              </h3>
              {runState.id === 'running'
                ? runningStories.map((entry) => (
                    <StoryCard key={entry.storyId} entry={entry} items={items} project={projects[entry.projectId]} showProject />
                  ))
                : null}
              {columns.get(runState.id)!.map((item) => (
                <ItemCard key={item.id} item={item} project={projects[item.projectId]} showProject />
              ))}
            </section>
          ),
        )}
      </div>
    </>
  );
}
