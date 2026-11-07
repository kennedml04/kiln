import { useState, type FormEvent } from 'react';
import type { ImportOptions, Project } from '@kiln/widget-sdk';
import { ApiError } from '../api.ts';
import { FolderBrowser } from '../FolderBrowser.tsx';
import { api } from '../store.ts';
import { ImportScan } from './ImportScan.tsx';

/**
 * + Project → Import: pick a folder in the tree or type its path, and register it where it is.
 * A folder that isn't a git repo is offered Initialise as a git repo; any other git problem is
 * refused with its fix (Kiln never switches branches). The scan shows what the folder holds; the
 * person confirms a test command, ticks modules and, when docs are missing, Bring it up to date.
 */
export function ImportProject({ onDone }: { onDone: (project: Project) => void }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [canInitialise, setCanInitialise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<ImportOptions>({});
  const register = async (init: boolean) => {
    setBusy(true);
    setError(undefined);
    setCanInitialise(false);
    try {
      const project = await api<Project>('POST', '/api/projects', { path: path.trim(), ...(init ? { init: true } : {}), ...choices });
      setPath('');
      onDone(project);
    } catch (err) {
      setError((err as Error).message);
      setCanInitialise(err instanceof ApiError && err.reason === 'not-a-repo');
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void register(false);
  };
  const pick = (picked: string) => {
    setPath(picked);
    setError(undefined);
    setCanInitialise(false);
  };
  return (
    <form className="register-project" aria-label="Import a Project" onSubmit={submit}>
      <p>Pick the Project's folder, or type its path. It stays where it is.</p>
      <FolderBrowser label="Folders" selected={path} onPick={pick} />
      <label>
        Repository path
        <input value={path} onChange={(e) => pick(e.target.value)} required spellCheck={false} placeholder="C:\path\to\repo" />
      </label>
      <ImportScan path={path} onChange={setChoices} />
      <button type="submit" disabled={busy || !path.trim()}>
        Register Project
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {canInitialise ? (
        <button type="button" disabled={busy} onClick={() => void register(true)}>
          Initialise as a git repo
        </button>
      ) : null}
    </form>
  );
}
