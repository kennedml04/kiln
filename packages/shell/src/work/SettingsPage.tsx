import { useEffect, useState, type FormEvent } from 'react';
import {
  POLICY_ACTION_NAMES,
  POLICY_ACTIONS,
  POLICY_DECISIONS,
  type CoreStatus,
  type OrgPolicy,
  type PolicyDecision,
  type Pool,
  type RestartPending,
  type Role,
  type SchedulerState,
  type SetupSettings,
  type SetupState,
  type User,
} from '@kiln/widget-sdk';
import { FolderBrowser } from '../FolderBrowser.tsx';
import { followLink } from '../router.ts';
import { SETUP_PATH } from '../SetupWizard.tsx';
import { MODELS_PATH } from './ModelsPage.tsx';
import { api, useStore } from '../store.ts';

function PoolRow({ pool }: { pool: Pool }) {
  const [size, setSize] = useState(String(pool.size));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api<SchedulerState>('PUT', `/api/scheduler/pools/${encodeURIComponent(pool.name)}`, { size: Number(size) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pool" aria-label={`${pool.name} pool`} onSubmit={save}>
      <span role="status">
        {pool.name}: {pool.size}
      </span>{' '}
      <span className="pool-active">({pool.active} in use)</span>
      <label>
        <span className="visually-hidden">{pool.name} pool size</span>
        <input type="number" min={0} step={1} value={size} onChange={(e) => setSize(e.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        Save {pool.name}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

/** The Org layer of the Policy: one rule per action. Project and Stage layers can only tighten it. */
function OrgPolicyForm() {
  const [actions, setActions] = useState<OrgPolicy['actions']>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<OrgPolicy>('GET', '/api/org-policy').then(
      (policy) => setActions(policy.actions),
      (err: Error) => setError(err.message),
    );
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const policy = await api<OrgPolicy>('PUT', '/api/org-policy', { actions });
      setActions(policy.actions);
      setStatus('Saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Org Policy" className="org-policy" onSubmit={save}>
      <p>What every Session may do. A Project or Stage can be stricter, never looser.</p>
      {actions
        ? POLICY_ACTIONS.map((action) => (
            <label key={action}>
              {POLICY_ACTION_NAMES[action]}{' '}
              <select value={actions[action]} onChange={(e) => setActions({ ...actions, [action]: e.target.value as PolicyDecision })}>
                {POLICY_DECISIONS.map((decision) => (
                  <option key={decision} value={decision}>
                    {decision}
                  </option>
                ))}
              </select>
            </label>
          ))
        : null}
      <button type="submit" disabled={busy || !actions}>
        Save the Org Policy
      </button>
      {status ? <span role="status">{status}</span> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

const ROLE_CHOICES: { value: string; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
  { value: '', label: 'No access' },
];

function RoleSelect({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {ROLE_CHOICES.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

const putRole = (id: string, role: string) => api<User>('PUT', `/api/users/${encodeURIComponent(id)}`, { role: (role || null) as Role | null });

function UserRow({ user, onSaved }: { user: User; onSaved: (user: User) => void }) {
  const [role, setRole] = useState(user.role ?? '');
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const who = user.name && user.name !== user.id ? `${user.name} (${user.id})` : user.id;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      onSaved(await putRole(user.id, role));
      setStatus('Saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>{who}</td>
      <td>
        {user.id === 'local' ? (
          'Admin (the local person)'
        ) : (
          <>
            <RoleSelect label={`Role for ${user.id}`} value={role} onChange={setRole} />{' '}
            <button type="button" onClick={save} disabled={busy}>
              Save
            </button>{' '}
            {status ? <span role="status">{status}</span> : null}
            {error ? <span role="alert">{error}</span> : null}
          </>
        )}
      </td>
      <td>{new Date(user.lastSeen).toLocaleString()}</td>
    </tr>
  );
}

/** Users and roles: everyone who has connected, plus people added by login before they visit. */
function UsersForm() {
  const [users, setUsers] = useState<User[]>();
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<User[]>('GET', '/api/users').then(setUsers, (err: Error) => setError(err.message));
  }, []);
  const saved = (user: User) => setUsers((list) => [...(list ?? []).filter((u) => u.id !== user.id), user]);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      saved(await putRole(login.trim(), role));
      setLogin('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>Who may use this Kiln. A person who connects with no role sees nothing until you give them one.</p>
      <table aria-label="Users and roles">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((user) => (
            <UserRow key={user.id} user={user} onSaved={saved} />
          ))}
        </tbody>
      </table>
      <form aria-label="Add a person" onSubmit={add}>
        <label>
          Login <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="name@example.com" required />
        </label>{' '}
        <RoleSelect label="Role for the new person" value={role} onChange={setRole} />{' '}
        <button type="submit" disabled={busy || !login.trim()}>
          Add person
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

/**
 * Folders: the Projects folder, the browse roots the folder browser may show, and the Knowledge
 * store folder (picked with the folder browser, or typed).
 */
function FoldersForm() {
  const [loaded, setLoaded] = useState<SetupState>();
  const [projectsFolder, setProjectsFolder] = useState('');
  const [roots, setRoots] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState('');
  const [knowledge, setKnowledge] = useState('');
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const show = (state: SetupState) => {
    setLoaded(state);
    setProjectsFolder(state.settings.projectsFolder ?? '');
    setRoots(state.settings.browseRoots ?? []);
    setKnowledge(state.settings.knowledgeDir ?? state.running.knowledgeDir);
  };
  useEffect(() => {
    api<SetupState>('GET', '/api/setup').then(show, (err: Error) => setError(err.message));
  }, []);
  const addRoot = () => {
    const root = newRoot.trim();
    if (root && !roots.includes(root)) setRoots([...roots, root]);
    setNewRoot('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const change: SetupSettings = { browseRoots: roots };
      if (projectsFolder.trim()) change.projectsFolder = projectsFolder.trim();
      if (loaded && knowledge.trim() && knowledge.trim() !== (loaded.settings.knowledgeDir ?? loaded.running.knowledgeDir)) {
        change.knowledgeDir = knowledge.trim();
      }
      show(await api<SetupState>('PUT', '/api/setup', change));
      setStatus('Saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!loaded) return error ? <p role="alert">{error}</p> : <p>Loading.</p>;
  const saved = loaded.settings;
  return (
    <form aria-label="Folders" className="folders" onSubmit={save}>
      <p>The folder browser (+ Project → Import, the Knowledge store) shows only these roots and the Projects folder.</p>
      <label>
        Projects folder
        <input value={projectsFolder} onChange={(e) => setProjectsFolder(e.target.value)} spellCheck={false} placeholder="C:\path\to\projects" />
      </label>
      <ul aria-label="Browse roots" className="browse-roots">
        {roots.map((root) => (
          <li key={root}>
            <span>{root}</span>{' '}
            <button type="button" onClick={() => setRoots(roots.filter((r) => r !== root))}>
              Remove {root}
            </button>
          </li>
        ))}
      </ul>
      <label>
        Add a browse root
        <input value={newRoot} onChange={(e) => setNewRoot(e.target.value)} spellCheck={false} placeholder="C:\path\to\folder" />
      </label>
      <button type="button" onClick={addRoot} disabled={!newRoot.trim()}>
        Add root
      </button>
      <label>
        Knowledge store folder
        <input value={knowledge} onChange={(e) => setKnowledge(e.target.value)} spellCheck={false} />
      </label>
      <FolderBrowser
        key={[saved.projectsFolder, ...(saved.browseRoots ?? [])].join('|')}
        label="Knowledge store folders"
        selected={knowledge}
        onPick={setKnowledge}
      />
      <button type="submit" disabled={busy}>
        Save folders
      </button>
      {status ? <span role="status">{status}</span> : null}
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

const plural =(n: number, word: string) => `${n} running ${word}${n === 1 ? '' : 's'}`;

/**
 * Restart when idle: Kiln stops starting new Sessions, waits for the running ones to finish, then
 * restarts (to pick up an update). It can be called off while it waits.
 */
function RestartWhenIdle() {
  const [pending, setPending] = useState<RestartPending>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lastEvent = useStore((s) => s.lastEvent);
  useEffect(() => {
    api<CoreStatus>('GET', '/api/status').then(
      (status) => setPending(status.restartPending),
      (err: Error) => setError(err.message),
    );
  }, []);
  useEffect(() => {
    if (lastEvent?.type === 'core.restart_pending') setPending(lastEvent.payload as RestartPending);
    if (lastEvent?.type === 'core.restart_cancelled') setPending(undefined);
  }, [lastEvent]);
  const call = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(undefined);
    try {
      const reply = await api<RestartPending | undefined>(method, '/api/core/restart-when-idle');
      setPending(method === 'POST' ? reply : undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="restart-when-idle">
      {pending ? (
        <>
          <span role="status">
            {pending.runningSessions
              ? `Restart when idle: waiting for ${plural(pending.runningSessions, 'Session')} to finish. No new Session starts meanwhile.`
              : 'Restarting now.'}
          </span>{' '}
          <button type="button" onClick={() => call('DELETE')} disabled={busy}>
            Call off the restart
          </button>
        </>
      ) : (
        <>
          <p>Restart Kiln once no Session runs, for example to pick up an update. Nothing running is interrupted.</p>
          <button type="button" onClick={() => call('POST')} disabled={busy}>
            Restart when idle
          </button>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

/** Admin settings: folders, users and roles, the Org Policy, the scheduler's capacity pools and Restart when idle. */
export function SettingsPage() {
  const pools = useStore((s) => s.scheduler?.pools ?? []);
  return (
    <section aria-label="Settings">
      <h2>Settings</h2>
      <p>
        <a href={SETUP_PATH} onClick={followLink}>
          Run setup again
        </a>{' '}
        to change the login mode, Budgets, Agents or the default Workflow's models.
      </p>
      <h3>Folders</h3>
      <FoldersForm />
      <h3>Users and roles</h3>
      <UsersForm />
      <h3>Org Policy</h3>
      <OrgPolicyForm />
      <h3>Models</h3>
      <p>
        <a href={MODELS_PATH} onClick={followLink}>
          Local models
        </a>
        : the local server, its variants and Add a model.
      </p>
      <h3>Capacity pools</h3>
      <p>How many Sessions each pool runs at once. Changes take effect straight away.</p>
      {pools.map((pool) => (
        <PoolRow key={pool.name} pool={pool} />
      ))}
      <h3>Restart</h3>
      <RestartWhenIdle />
    </section>
  );
}
