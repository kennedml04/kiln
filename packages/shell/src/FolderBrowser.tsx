// The folder browser: a clickable tree of the folders under the browse roots, served by the core
// (`GET /api/fs/folders`, Admin only), so it works the same from a phone. Clicking a folder picks it
// and opens it. Each folder says whether it is a git repo, already registered, or has a `.scratch` tracker.
import { useEffect, useState } from 'react';
import type { FolderEntry, FolderListing } from '@kiln/widget-sdk';
import { api, ApiError } from './api.ts';

const listingOf = (path?: string) =>
  api<FolderListing>('GET', `/api/fs/folders${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`);

function Badges({ folder }: { folder: FolderEntry }) {
  const badges = [folder.git && 'git repo', folder.registered && 'registered', folder.tracker && '.scratch'].filter(Boolean) as string[];
  return (
    <>
      {badges.map((badge) => (
        <span key={badge} className="folder-badge">
          {badge}
        </span>
      ))}
    </>
  );
}

function FolderNode({ folder, selected, onPick }: { folder: FolderEntry; selected?: string; onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FolderEntry[]>();
  const [error, setError] = useState<string>();
  const click = () => {
    onPick(folder.path);
    if (open) return setOpen(false);
    setOpen(true);
    if (children) return;
    listingOf(folder.path).then(
      (listing) => setChildren(listing.folders),
      (err: Error) => setError(err.message),
    );
  };
  const isSelected = selected !== undefined && selected.toLowerCase() === folder.path.toLowerCase();
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={isSelected} aria-label={folder.name}>
      <button type="button" className={`folder${isSelected ? ' selected' : ''}`} onClick={click}>
        <span className="folder-name">{folder.name}</span> <Badges folder={folder} />
      </button>
      {open ? (
        <ul role="group">
          {error ? <li role="alert">{error}</li> : null}
          {children === undefined && !error ? <li className="folder-empty">Loading.</li> : null}
          {children?.length === 0 ? <li className="folder-empty">No folders inside.</li> : null}
          {children?.map((child) => (
            <FolderNode key={child.path} folder={child} selected={selected} onPick={onPick} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The tree from the browse roots down. `onPick` gets each folder clicked; `selected` is highlighted. */
export function FolderBrowser({ label, selected, onPick }: { label: string; selected?: string; onPick: (path: string) => void }) {
  const [roots, setRoots] = useState<FolderEntry[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    listingOf().then(
      (listing) => setRoots(listing.folders),
      (err: Error) =>
        setError(err instanceof ApiError && err.reason === 'role' ? 'Only an Admin can browse folders. Type the path instead.' : err.message),
    );
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!roots) return <p className="folder-empty">Loading folders.</p>;
  if (!roots.length) {
    return <p className="folder-empty">No folders to browse yet. An Admin adds browse roots in Settings; until then, type the path.</p>;
  }
  return (
    <ul role="tree" aria-label={label} className="folder-tree">
      {roots.map((root) => (
        <FolderNode key={root.path} folder={root} selected={selected} onPick={onPick} />
      ))}
    </ul>
  );
}
