// The Widgets page: allowed sources, installs, Manifests, approvals and health. Each Widget with
// panels also gets its own page (`/widgets/<id>`, listed under Widgets in the sidebar), which is the
// only place its panels show. Everyone with a role sees them; only Admins get the install form and
// the buttons.
import { useEffect, useState, type FormEvent } from 'react';
import type { WidgetInfo, WidgetNeeds, WidgetPin, WidgetSourcePolicy, WidgetState } from '@kiln/widget-sdk';
import { api } from './api.ts';
import { Panels } from './Panels.tsx';
import { followLink, usePath } from './router.ts';
import { useStore } from './store.ts';

const STATE_LABELS: Partial<Record<WidgetState, string>> = { 'awaiting-approval': 'awaiting approval' };

/** The Manifest's needs, in the same words the core uses for new needs. */
function describeNeeds(needs: WidgetNeeds | undefined): string[] {
  if (!needs) return [];
  const out: string[] = [];
  for (const work of needs.work ?? []) {
    out.push(`work: ${work.access} ${work.projects === '*' ? 'all Projects' : `Projects ${work.projects.join(', ')}`}`);
  }
  if (needs.asks) out.push('asks');
  for (const domain of needs.network ?? []) out.push(`network: ${domain}`);
  for (const secret of needs.secrets ?? []) out.push(`secret: ${secret}`);
  if (needs.dataFolder) out.push('data folder');
  return out;
}

const describePin = (pin: WidgetPin) =>
  pin.kind === 'git'
    ? `${pin.source}${pin.path ? ` (${pin.path})` : ''} @ ${pin.tag ?? pin.ref ?? ''} ${pin.commit?.slice(0, 12) ?? ''}`.replace(/@ {2}/, '@ ')
    : `${pin.source}${pin.path ? ` (${pin.path})` : ''}, folder ${pin.hash?.slice(0, 19) ?? ''}`;

function NeedList({ label, needs }: { label: string; needs: string[] }) {
  return (
    <div>
      <h4>{label}</h4>
      {needs.length === 0 ? <p>Nothing</p> : <ul>{needs.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

function WidgetCard({ widget, isAdmin, onError }: { widget: WidgetInfo; isAdmin: boolean; onError(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const act = (method: string, path: string) => async () => {
    setBusy(true);
    try {
      await api(method, path);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const base = `/api/widgets/${encodeURIComponent(widget.id)}`;
  const running = widget.pid !== null;
  const titleId = `widget-${widget.id}`;
  const pools = Object.entries(widget.manifest.provides?.pools ?? {}).map(([pool, size]) => `pool: ${pool} ${size}`);
  const agents = (widget.manifest.provides?.agents ?? []).map((a) => `Agent: ${a.name} (${a.id})`);
  return (
    <article className={`widget widget-${widget.state}`} aria-labelledby={titleId}>
      <h3 id={titleId}>{widget.name}</h3>
      <p>
        <code>{widget.id}</code> {widget.version} <span className="widget-state">{STATE_LABELS[widget.state] ?? widget.state}</span>
        {widget.restarts > 0 && ` (restarted ${widget.restarts}x)`}
      </p>
      {widget.problem && <p className="widget-problem">{widget.problem}</p>}
      <p className="widget-pin">{describePin(widget.pin)}</p>
      <div className="widget-manifest">
        <NeedList label="Needs" needs={[...describeNeeds(widget.manifest.needs), ...pools]} />
        {agents.length > 0 && <NeedList label="Provides" needs={agents} />}
        <p>{widget.grants ? `Approved by ${widget.grants.approvedBy}, ${new Date(widget.grants.approvedAt).toLocaleString()}` : 'Not approved'}</p>
      </div>
      {widget.pendingUpdate && (
        <div className="widget-pending">
          <p>
            Update to {widget.pendingUpdate.manifest.version} waits for approval. It asks for more:
          </p>
          <ul>{widget.pendingUpdate.newNeeds.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      {isAdmin && (
        <div className="widget-actions">
          {(!widget.grants || widget.pendingUpdate) && (
            <button disabled={busy} onClick={act('POST', `${base}/approve`)}>
              Approve
            </button>
          )}
          {widget.grants && !running && widget.state !== 'incompatible' && (
            <button disabled={busy} onClick={act('POST', `${base}/start`)}>
              Start
            </button>
          )}
          {running && (
            <button disabled={busy} onClick={act('POST', `${base}/stop`)}>
              Stop
            </button>
          )}
          <button disabled={busy} onClick={act('POST', `${base}/update`)}>
            Update
          </button>
          <button disabled={busy} onClick={act('DELETE', base)}>
            Remove
          </button>
        </div>
      )}
    </article>
  );
}

function InstallForm({ onError }: { onError(message: string): void }) {
  const [source, setSource] = useState('');
  const [ref, setRef] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api('POST', '/api/widgets', { source, ...(ref ? { ref } : {}) });
      setSource('');
      setRef('');
    } catch (err) {
      onError((err as Error).message);
    }
  };
  return (
    <form className="filters" onSubmit={submit} aria-label="Install a Widget">
      <label>
        Source
        <input value={source} placeholder="git URL or folder" onChange={(e) => setSource(e.target.value)} required />
      </label>
      <label>
        Ref
        <input value={ref} placeholder="tag, branch or commit" onChange={(e) => setRef(e.target.value)} />
      </label>
      <button type="submit">Install</button>
    </form>
  );
}

/** Widget events that change the list (not panel updates, page messages, logs or actions). */
const LIFECYCLE = /^(?:widget\.(?!panel_|page_|log|request|action)|org_policy\.)/;

/** The id of the last lifecycle or Org Policy event, so a list reloads after one. */
function useWidgetEvent() {
  const [id, setId] = useState(0);
  const event = useStore((s) => s.lastEvent);
  useEffect(() => {
    if (event && LIFECYCLE.test(event.type)) setId(event.id);
  }, [event]);
  return id;
}

/** The installed Widgets, reloaded after each Widget event. */
function useWidgets(onError?: (message: string) => void): WidgetInfo[] | undefined {
  const [widgets, setWidgets] = useState<WidgetInfo[]>();
  const relevant = useWidgetEvent();
  useEffect(() => {
    let current = true;
    api<WidgetInfo[]>('GET', '/api/widgets')
      .then((list) => current && setWidgets(list))
      .catch((err: Error) => current && onError?.(err.message));
    return () => {
      current = false;
    };
  }, [relevant]);
  return widgets;
}

/** A Widget's own page. */
export const widgetPath = (id: string) => `/widgets/${encodeURIComponent(id)}`;
export const WIDGET_ROUTE = /^\/widgets\/([^/]+)\/?$/;

/** Widgets with a page of their own: the ones whose Manifest declares panels. */
const hasPanels = (w: WidgetInfo) => (w.manifest.provides?.panels ?? []).length > 0;

/** The Widgets submenu in the sidebar: one entry per Widget with panels. */
export function WidgetsNav() {
  const widgets = useWidgets()?.filter(hasPanels) ?? [];
  const path = usePath();
  if (widgets.length === 0) return null;
  return (
    <ul className="nav-sub" aria-label="Widget pages">
      {widgets.map((w) => {
        const to = widgetPath(w.id);
        return (
          <li key={w.id}>
            <a href={to} onClick={followLink} aria-current={path === to ? 'page' : undefined}>
              {w.name}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** One Widget's space: its panels, then its state and buttons. */
export function WidgetPage({ widgetId, isAdmin }: { widgetId: string; isAdmin: boolean }) {
  const [error, setError] = useState<string>();
  const widgets = useWidgets(setError);
  const widget = widgets?.find((w) => w.id === widgetId);
  const shown = useStore((s) => Object.values(s.panels).some((p) => p.widgetId === widgetId));
  if (widgets && !widget) {
    return (
      <section className="widgets">
        <h2>Widget not found</h2>
        <p>
          No Widget <code>{widgetId}</code> is installed. <a href="/widgets" onClick={followLink}>All Widgets</a>
        </p>
      </section>
    );
  }
  return (
    <section className="widgets">
      <h2>{widget?.name ?? widgetId}</h2>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setError(undefined)}>Dismiss</button>
        </p>
      )}
      <Panels widgetId={widgetId} />
      {widget && !shown && hasPanels(widget) && <p className="panel-empty">Its panels show here while the Widget runs.</p>}
      {widget && <WidgetCard widget={widget} isAdmin={isAdmin} onError={setError} />}
    </section>
  );
}

export function WidgetsPage({ isAdmin }: { isAdmin: boolean }) {
  const [policy, setPolicy] = useState<WidgetSourcePolicy>();
  const [error, setError] = useState<string>();
  const widgets = useWidgets(setError);
  const relevant = useWidgetEvent();

  useEffect(() => {
    let current = true;
    if (isAdmin) {
      api<WidgetSourcePolicy>('GET', '/api/org-policy/widget-sources')
        .then((p) => current && setPolicy(p))
        .catch(() => undefined);
    }
    return () => {
      current = false;
    };
  }, [relevant, isAdmin]);

  return (
    <section className="widgets">
      <h2>Widgets</h2>
      {error && (
        <p role="alert">
          {error} <button onClick={() => setError(undefined)}>Dismiss</button>
        </p>
      )}
      {policy && (
        <section aria-label="Allowed sources">
          <h3>Allowed sources</h3>
          {policy.allowed === null ? (
            <p>Any source (the Org Policy sets no limit)</p>
          ) : (
            <ul>{policy.allowed.map((s) => <li key={s}><code>{s}</code></li>)}</ul>
          )}
        </section>
      )}
      {isAdmin && <InstallForm onError={setError} />}
      {widgets && widgets.length === 0 && <p>No Widgets installed.</p>}
      {widgets?.map((w) => <WidgetCard key={w.id} widget={w} isAdmin={isAdmin} onError={setError} />)}
    </section>
  );
}
