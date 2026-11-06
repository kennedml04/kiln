// Make it a Story (scratch-chat/08): pick a Project and optionally an Epic, wait for the chat to
// draft a title and a short story.md, edit the draft, then Accept (creates the grill-stage Story)
// or Cancel (creates nothing). A draft left pending for 30 minutes is dropped by the core.
import { useEffect, useState } from 'react';
import type { ChatStoryDraft, Item, MakeStoryRequest, OpenStoryDraftRequest, ScratchChat } from '@kiln/widget-sdk';
import { ApiError } from '../api.ts';
import { api, useStore } from '../store.ts';

const POLL_MS = 1000;

export function MakeStoryDialog({ chat, onClose, onMade }: { chat: ScratchChat; onClose: () => void; onMade?: (story: Item) => void }) {
  const projects = useStore((s) => Object.values(s.projects));
  const items = useStore((s) => s.items);
  const [projectId, setProjectId] = useState('');
  const [parentId, setParentId] = useState('');
  const [draft, setDraft] = useState<ChatStoryDraft>();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const path = `/api/chats/${encodeURIComponent(chat.id)}/story-draft`;

  // Pick up a draft that is already pending (the dialog was closed and reopened).
  useEffect(() => {
    api<ChatStoryDraft>('GET', path).then(
      (found) => {
        setDraft(found);
        setProjectId(found.projectId);
        setParentId(found.parentId ?? '');
      },
      () => undefined,
    );
  }, [path]);

  // While waiting for the chat, watch for its draft; if it is dropped (expired), say so.
  const waiting = draft !== undefined && draft.title === undefined;
  useEffect(() => {
    if (!draft) return;
    const timer = setInterval(() => {
      api<ChatStoryDraft>('GET', path).then(
        (found) => {
          setDraft(found);
          if (found.title !== undefined && !edited) {
            setTitle(found.title);
            setDescription(found.description ?? '');
          }
        },
        (err) => {
          if (err instanceof ApiError && err.status === 404) {
            setDraft(undefined);
            setError('The draft expired or was dropped. Start again.');
          }
        },
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [draft !== undefined, edited, path]);

  const project = projects.find((p) => p.id === projectId);
  const parentKind = project?.workflow.kinds.find((k) => k.id === 'story')?.parentKind;
  const epics = Object.values(items).filter((i) => i.projectId === projectId && parentKind !== undefined && i.kind === parentKind);

  const start = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const body: OpenStoryDraftRequest = { projectId, ...(parentId ? { parentId } : {}) };
      setDraft(await api<ChatStoryDraft>('POST', path, body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    try {
      if (draft) await api('DELETE', path);
    } catch {
      // Nothing was created either way.
    }
    onClose();
  };
  const accept = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const body: MakeStoryRequest = { projectId, ...(parentId ? { parentId } : {}), title, description };
      const story = await api<Item>('POST', `/api/chats/${encodeURIComponent(chat.id)}/story`, body);
      onMade?.(story);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Make it a Story">
        <h2>Make it a Story</h2>
        {!draft ? (
          <>
            <p>Which Project is this Story for?</p>
            <label>
              Project
              <select value={projectId} onChange={(e) => (setProjectId(e.target.value), setParentId(''))}>
                <option value="">Choose a Project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {epics.length ? (
              <label>
                Epic (optional)
                <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <option value="">No Epic</option>
                  {epics.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : waiting ? (
          <p role="status">The chat is drafting the Story…</p>
        ) : (
          <>
            <label>
              Title
              <input value={title} onChange={(e) => (setEdited(true), setTitle(e.target.value))} />
            </label>
            <label>
              Description
              <textarea value={description} rows={8} onChange={(e) => (setEdited(true), setDescription(e.target.value))} />
            </label>
          </>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          {!draft ? (
            <button type="button" disabled={busy || !projectId} onClick={start}>
              Draft it
            </button>
          ) : !waiting ? (
            <button type="button" disabled={busy || !title.trim()} onClick={accept}>
              Accept
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
