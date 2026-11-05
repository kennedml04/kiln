// + Project → New (project-wizard ticket 02): a name and a one-line description make
// `<Projects folder>\<name>`, its first commit, the Project and its "What we're building" Story,
// which opens at grill. The Projects folder is asked for the first time only, then remembered.
import { useEffect, useState, type FormEvent } from 'react';
import type { NewProjectResult, SetupState } from '@kiln/widget-sdk';
import { ApiError } from '../api.ts';
import { FolderBrowser } from '../FolderBrowser.tsx';
import { itemPath, navigate } from '../router.ts';
import { api } from '../store.ts';

export function NewProject({ onDone }: { onDone: () => void }) {
  // undefined while loading; '' when no Projects folder is set yet.
  const [projectsFolder, setProjectsFolder] = useState<string>();
  const [folderInput, setFolderInput] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<SetupState>('GET', '/api/setup')
      .then((setup) => live && setProjectsFolder(setup.settings.projectsFolder ?? ''))
      .catch(() => live && setProjectsFolder(''));
    return () => {
      live = false;
    };
  }, []);

  const asking = projectsFolder === '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (asking) {
        const saved = await api<SetupState>('PUT', '/api/setup', { projectsFolder: folderInput.trim() });
        setProjectsFolder(saved.settings.projectsFolder ?? '');
      }
      const { item } = await api<NewProjectResult>('POST', '/api/projects/new', { name: name.trim(), description: description.trim() });
      setName('');
      setDescription('');
      onDone();
      navigate(itemPath(item.id));
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.reason === 'no-projects-folder') setProjectsFolder('');
    } finally {
      setBusy(false);
    }
  };

  if (projectsFolder === undefined) return <p>Loading…</p>;
  return (
    <form className="register-project" aria-label="New Project" onSubmit={(e) => void submit(e)}>
      {asking ? (
        <>
          <p>Choose the Projects folder first. Kiln makes each new Project in a folder of its own there, and remembers it.</p>
          <FolderBrowser label="Projects folders" selected={folderInput} onPick={setFolderInput} />
          <label>
            Projects folder
            <input value={folderInput} onChange={(e) => setFolderInput(e.target.value)} required spellCheck={false} placeholder="C:\path\to\Projects" />
          </label>
        </>
      ) : (
        <p>Made in {projectsFolder}, with a first commit and a "What we're building" Story to grill.</p>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required spellCheck={false} />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} required placeholder="One line: what it is for" />
      </label>
      <button type="submit" disabled={busy || !name.trim() || !description.trim() || (asking && !folderInput.trim())}>
        Create Project
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
