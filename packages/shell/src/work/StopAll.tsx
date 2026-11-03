import { useState } from 'react';
import type { SchedulerState } from '@kiln/widget-sdk';
import { api, useStore } from '../store.ts';

/**
 * The always-visible Stop all control in the header. After a confirmation it pauses every running
 * Session and the queue; while stopped it shows Resume instead.
 */
export function StopAll({ canAct }: { canAct: boolean }) {
  const paused = useStore((s) => s.scheduler?.paused ?? false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const call = async (path: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api<SchedulerState>('POST', path);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (paused) {
    return (
      <div className="stop-all stopped">
        <span role="status">Everything is stopped</span>
        {canAct ? (
          <button type="button" onClick={() => call('/api/scheduler/resume')} disabled={busy}>
            Resume
          </button>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
    );
  }
  if (!canAct) return null;
  return (
    <div className="stop-all">
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        Stop all
      </button>
      {confirming ? (
        <div className="dialog-backdrop">
          <div role="alertdialog" aria-modal="true" aria-labelledby="stop-all-title" aria-describedby="stop-all-body" className="dialog">
            <h2 id="stop-all-title">Stop all?</h2>
            <p id="stop-all-body">
              Every running Session pauses and nothing new starts until you resume. Nothing is killed, and the work
              continues where it left off.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => call('/api/scheduler/stop-all')} disabled={busy}>
                Stop everything
              </button>
            </div>
            {error ? <p role="alert">{error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
