// The demo Project on a dev instance (demo-project Ticket 08): "Start demo" on the demo Project,
// "Add the demo" on the all-Projects view, and the Replay note.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { DemoMode, DemoState, StartDemoRequest } from '@kiln/widget-sdk';
import { navigate, projectPath } from '../router.ts';
import { api, useStore } from '../store.ts';

// `GET /api/demo`, shared by every view. A newer answer always wins: `seq` drops a GET that was
// sent before the last change, so a start's own result is never overwritten by a stale read.
let demo: DemoState | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const setDemo = (next: DemoState) => {
  demo = next;
  for (const listener of listeners) listener();
};

async function refreshDemo() {
  const mine = ++seq;
  let next: DemoState;
  try {
    next = await api<DemoState>('GET', '/api/demo');
  } catch {
    // Not an Admin (403), or not reachable: offer nothing.
    next = { available: false };
  }
  if (mine === seq) setDemo(next);
}

/** The demo's state, read again whenever the set of Projects changes (a start removes one and adds one). */
export function useDemo(): DemoState | undefined {
  const projectIds = useStore((s) => Object.keys(s.projects).sort().join('\n'));
  useEffect(() => {
    void refreshDemo();
  }, [projectIds]);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => demo,
  );
}

const MODES: { id: DemoMode; name: string }[] = [
  { id: 'replay', name: 'Replay (no models)' },
  { id: 'live', name: 'Live (your Agents)' },
];

/**
 * A Replay/Live choice and a button that starts a fresh demo after an in-page confirmation, then
 * opens the new demo Project. A refusal (Live with a role unset, a refused Widget source) shows here.
 */
export function DemoControls({ state, action }: { state: DemoState; action: 'Start demo' | 'Add the demo' }) {
  const [mode, setMode] = useState<DemoMode>(state.mode ?? 'replay');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const modeName = MODES.find((m) => m.id === mode)!.name;

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body: StartDemoRequest = { mode };
      const started = await api<DemoState>('POST', '/api/demo/start', body);
      seq++; // drops any read sent while the start ran
      setDemo(started);
      setConfirming(false);
      if (started.projectId) navigate(projectPath(started.projectId));
    } catch (err) {
      setConfirming(false);
      setError((err as Error).message);
      void refreshDemo();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <fieldset className="demo-controls">
        <legend>Demo</legend>
        {MODES.map((m) => (
          <label key={m.id}>
            <input type="radio" name="demo-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />{' '}
            {m.name}
          </label>
        ))}
        <button type="button" onClick={() => setConfirming(true)} disabled={busy}>
          {action}
        </button>
        {error ? <p role="alert" className="notice">{error}</p> : null}
      </fieldset>
      {confirming ? (
        <div className="dialog-backdrop">
          <div role="alertdialog" aria-modal="true" aria-labelledby="demo-start-title" aria-describedby="demo-start-body" className="dialog">
            <h2 id="demo-start-title">{action}?</h2>
            <p id="demo-start-body">
              {state.projectId
                ? `The current demo run is thrown away: its Project, its repo, its worktrees and its Sessions. A fresh demo starts in ${modeName}.`
                : `This adds the demo Project, a small repo with one Story, in ${modeName}.`}
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
                Cancel
              </button>
              <button type="button" onClick={start} disabled={busy}>
                {action}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * What to do in Replay. The approval order works around `Blocked by` not being enforced by the
 * scheduler (demo-project spec, Further Notes): drop that item once it is.
 */
export function ReplayNote() {
  return (
    <div role="note" aria-label="Replay" className="setup-hint demo-note">
      <p>Replay plays a scripted run on the fake Agent: no models, and your answers don't steer it.</p>
      <ol>
        <li>Open the Story and start a Session, then answer the Asks in Needs you.</li>
        <li>Approve the Gates.</li>
        <li>
          Approve Ticket 01's Review and wait for it to ship before you approve Ticket 02's. Approving both at once makes
          the two merges collide on git's index.lock (a known core bug).
        </li>
      </ol>
    </div>
  );
}
