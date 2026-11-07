import { useMemo, useState, type DragEvent } from 'react';
import type { Item, Project, RunState } from '@kiln/widget-sdk';
import { followLink, projectPath } from '../router.ts';
import { api, useStore } from '../store.ts';
import { BoardMenu } from './BoardMenu.tsx';
import { DemoControls, useDemo } from './Demo.tsx';
import { ImportProject } from './ImportProject.tsx';
import { ITEM_DRAG_TYPE, ItemCard } from './ItemCard.tsx';
import { NewProject } from './NewProject.tsx';

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

/** Up next in start order. Dropping a card on another moves it just before that one. */
function UpNext({ items, projects }: { items: Item[]; projects: Record<string, Project> }) {
  const [error, setError] = useState<string>();
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(ITEM_DRAG_TYPE)) event.preventDefault();
  };
  const dropBefore = (targetId: string | undefined) => async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(ITEM_DRAG_TYPE);
    if (!id || id === targetId || !items.some((i) => i.id === id)) return;
    const order = items.map((i) => i.id).filter((i) => i !== id);
    const at = targetId ? order.indexOf(targetId) : order.length;
    order.splice(at < 0 ? order.length : at, 0, id);
    setError(undefined);
    try {
      await api('PUT', '/api/scheduler/queue', { order });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="column" aria-label="Up next" onDragOver={onDragOver} onDrop={dropBefore(undefined)}>
      <h3>
        Up next <span className="count">{items.length}</span>
      </h3>
      {items.map((item) => (
        <div key={item.id} onDragOver={onDragOver} onDrop={dropBefore(item.id)}>
          <ItemCard item={item} project={projects[item.projectId]} showProject />
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
  const queue = useStore((s) => s.scheduler?.queue);
  const demo = useDemo();
  const columns = useMemo(() => {
    const grouped = new Map<RunState, Item[]>(RUN_STATES.map((r) => [r.id, []]));
    for (const item of Object.values(items)) if (!item.archived) grouped.get(item.runState)?.push(item);
    // Up next shows the scheduler's start order; anything it doesn't know yet goes last.
    const position = new Map((queue ?? []).map((entry, i) => [entry.itemId, i]));
    grouped.get('up-next')!.sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
    return grouped;
  }, [items, queue]);
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
            <UpNext key={runState.id} items={columns.get('up-next')!} projects={projects} />
          ) : (
            <section key={runState.id} className="column" aria-label={runState.name}>
              <h3>
                {runState.name} <span className="count">{columns.get(runState.id)!.length}</span>
              </h3>
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
