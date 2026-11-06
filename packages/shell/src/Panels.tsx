// Widget panels in the Shell. A declarative panel is drawn by the Shell from blocks the Widget
// published; a page panel is the Widget's own page in a sandboxed iframe with an opaque origin,
// so it can't reach the Shell's DOM, cookies or API, or another Widget's page. Its only way out is
// the postMessage bridge below, which acts for the Widget that owns the frame and no other.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageToShell, PanelBlock, PanelView, ShellToPage } from '@kiln/widget-sdk';
import { api, onPageMessage, useStore } from './store.ts';

const runAction = (panel: PanelView, action: string, input: unknown) =>
  api('POST', `/api/widgets/${encodeURIComponent(panel.widgetId)}/actions/${encodeURIComponent(action)}`, {
    panelId: panel.panelId,
    input: input ?? null,
  });

function ActionButton({ panel, label, action, input }: { panel: PanelView; label: string; action: string; input?: unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const press = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await runAction(panel, action, input);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" disabled={busy} onClick={press}>
        {label}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </>
  );
}

function Blocks({ panel, blocks }: { panel: PanelView; blocks: PanelBlock[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        const key = block.id ?? i;
        switch (block.kind) {
          case 'stat':
            return (
              <div key={key} className="panel-stat">
                <span className="panel-stat-label">{block.label}</span>{' '}
                <strong>{`${block.value}${block.unit ?? ''}`}</strong>
              </div>
            );
          case 'card':
            return (
              <div key={key} className="panel-card">
                <h4>{block.title}</h4>
                {block.text ? <p>{block.text}</p> : null}
                {block.blocks ? <Blocks panel={panel} blocks={block.blocks} /> : null}
              </div>
            );
          case 'table':
            return (
              <table key={key} aria-label={block.title}>
                <thead>
                  <tr>
                    {block.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>{String(cell ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case 'button':
            return <ActionButton key={key} panel={panel} label={block.label} action={block.action} input={block.input} />;
          default:
            return null;
        }
      })}
    </>
  );
}

function PagePanel({ panel }: { panel: PanelView }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Only messages from this frame's own window count, whatever they claim to be.
    const fromPage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as PageToShell | null;
      if (data?.kiln === 'action' && typeof data.action === 'string') void runAction(panel, data.action, data.input).catch(() => {});
    };
    window.addEventListener('message', fromPage);
    const stop = onPageMessage((m) => {
      if (m.widgetId !== panel.widgetId || m.panelId !== panel.panelId) return;
      const message: ShellToPage = { kiln: 'message', message: m.message };
      // The page's origin is opaque, so `*` is the only target that reaches it; the window is this frame's.
      frame.current?.contentWindow?.postMessage(message, '*');
    });
    return () => {
      window.removeEventListener('message', fromPage);
      stop();
    };
  }, [panel.widgetId, panel.panelId]);

  return <iframe ref={frame} title={panel.title} src={panel.pageUrl} sandbox="allow-scripts" className="panel-page" />;
}

function Panel({ panel }: { panel: PanelView }) {
  return (
    <section className="panel" aria-label={panel.title}>
      <h3>{panel.title}</h3>
      {panel.kind === 'page' ? (
        <PagePanel panel={panel} />
      ) : panel.content ? (
        <Blocks panel={panel} blocks={panel.content.blocks} />
      ) : (
        <p className="panel-empty">Waiting for the Widget.</p>
      )}
    </section>
  );
}

/** One Widget's panels, drawn on its own page under Widgets (`/widgets/<id>`). */
export function Panels({ widgetId }: { widgetId: string }) {
  const all = useStore((s) => s.panels);
  const panels = useMemo(() => Object.values(all).filter((p) => p.widgetId === widgetId), [all, widgetId]);
  if (panels.length === 0) return null;
  return (
    <div className="panels">
      {panels.map((p) => (
        <Panel key={`${p.widgetId}/${p.panelId}`} panel={p} />
      ))}
    </div>
  );
}
