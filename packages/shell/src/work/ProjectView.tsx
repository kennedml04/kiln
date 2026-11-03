import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import type { CreateItemRequest, Item, ItemKind, Project, Stage } from '@kiln/widget-sdk';
import { followLink, projectThreadPath } from '../router.ts';
import { api, useStore } from '../store.ts';
import { ITEM_DRAG_TYPE, ItemCard } from './ItemCard.tsx';

function NewItemForm({ project, items }: { project: Project; items: Item[] }) {
  const kinds = project.workflow.kinds;
  const [kindId, setKindId] = useState(kinds[0]?.id ?? '');
  const [parentId, setParentId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const kind = kinds.find((k) => k.id === kindId);
  const parents = items.filter((i) => kind?.parentKind && i.kind === kind.parentKind);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    const body: CreateItemRequest = { kind: kindId, title, description: description || undefined, parentId: parentId || undefined };
    try {
      await api<Item>('POST', `/api/projects/${encodeURIComponent(project.id)}/items`, body);
      setTitle('');
      setDescription('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="new-item" aria-label="New Item" onSubmit={submit}>
      <label>
        Kind
        <select
          value={kindId}
          onChange={(e) => {
            setKindId(e.target.value);
            setParentId('');
          }}
        >
          {kinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Parent
        <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={!kind?.parentKind}>
          <option value="">(none)</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <button type="submit">Create</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

interface ColumnProps {
  project: Project;
  kind: ItemKind;
  stage: Stage;
  items: Item[];
  onRefused(message: string): void;
}

function StageColumn({ project, kind, stage, items, onRefused }: ColumnProps) {
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(ITEM_DRAG_TYPE)) event.preventDefault();
  };
  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const id = event.dataTransfer.getData(ITEM_DRAG_TYPE);
    if (!id || items.some((i) => i.id === id)) return;
    try {
      await api('PATCH', `/api/items/${encodeURIComponent(id)}`, { stage: stage.id });
    } catch (err) {
      onRefused((err as Error).message);
    }
  };
  return (
    <section className="column" aria-label={`${kind.name} ${stage.name}`} onDragOver={onDragOver} onDrop={onDrop}>
      <h3>
        {stage.name}
        {stage.gate ? <span className="gate" title="Gate: needs a person's approval"> Gate</span> : null}{' '}
        <span className="count">{items.length}</span>
      </h3>
      {items.map((item) => (
        <ItemCard key={item.id} item={item} project={project} />
      ))}
    </section>
  );
}

/** One Project: a row group per Item kind, a column per Stage of that kind. */
export function ProjectView({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId]);
  const allItems = useStore((s) => s.items);
  const [notice, setNotice] = useState<string>();
  const items = useMemo(() => Object.values(allItems).filter((i) => i.projectId === projectId), [allItems, projectId]);

  if (!project) return <p>Loading Project…</p>;
  return (
    <>
      <h2>{project.name}</h2>
      <p className="project-path">{project.path}</p>
      <a href={projectThreadPath(project.id)} onClick={followLink}>
        Project Thread
      </a>
      {project.errors?.length ? (
        <div role="alert" className="notice project-errors">
          <p>
            {project.workflowSource === 'file'
              ? 'A Kiln file has problems, so the board keeps its last valid Workflow:'
              : 'A Kiln file has problems:'}
          </p>
          <ul>
            {project.errors.map((e) => (
              <li key={`${e.file} ${e.at} ${e.message}`}>
                <code>{e.file}</code> {e.at ? <code>{e.at}</code> : null} <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <NewItemForm project={project} items={items} />
      {notice ? (
        <p role="alert" className="notice">
          {notice}{' '}
          <button type="button" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </p>
      ) : null}
      {project.workflow.kinds.map((kind) => (
        <section key={kind.id} className="kind-row" aria-label={`${kind.name} Items`}>
          <h3>{kind.name}</h3>
          <div className="board">
            {kind.stages.map((stage) => (
              <StageColumn
                key={stage.id}
                project={project}
                kind={kind}
                stage={stage}
                items={items.filter((i) => i.kind === kind.id && i.stage === stage.id)}
                onRefused={setNotice}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
