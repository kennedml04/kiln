// Widget panels: declarative content the Widget publishes, embedded pages, and actions.
//
// Content lives in memory only: a Widget publishes again whenever it starts, and its panels are
// emptied when its process ends. Each change is a `widget.panel_updated` event the Shell patches in.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, normalize, resolve, sep } from 'node:path';
import type {
  ActionRequest,
  Actor,
  PanelBlock,
  PanelContent,
  PanelDeclaration,
  PanelView,
  WidgetActionCommand,
  WidgetInfo,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { WidgetHostError, type WidgetHost } from '../widget-host.ts';

const MAX_CONTENT_BYTES = 256 * 1024;
const RUNNING = new Set(['starting', 'registered', 'ready']);

export interface WidgetPanels {
  /** Every panel of every running Widget. */
  list(): PanelView[];
  /** A Widget replaces one of its declarative panels' content. */
  publish(widgetId: string, panelId: string, content: unknown): PanelView;
  /** A Widget sends a message to its embedded page (through the Shell). */
  pageMessage(widgetId: string, panelId: string, message: unknown): void;
  /** A person pressed a button (or a page asked): hands the action to the Widget. */
  action(widgetId: string, action: string, request: ActionRequest, by: Actor): void;
  /** The file of an embedded page to serve, or a 404. `relative` is the path under the page's folder. */
  pageFile(widgetId: string, panelId: string, relative: string): string;
}

export interface PanelDeps {
  bus: EventBus;
  host: WidgetHost;
  /** The installs (manifests, folders and states). */
  widgets(): WidgetInfo[];
}

const fail = (message: string): never => {
  throw new WidgetHostError(400, message);
};

const isText = (v: unknown) => typeof v === 'string';

function checkBlocks(blocks: unknown, actions: Set<string>, where: string): void {
  if (!Array.isArray(blocks)) fail(`${where} must be a list of blocks`);
  for (const [i, raw] of (blocks as unknown[]).entries()) {
    const at = `${where}[${i}]`;
    const block = raw as PanelBlock;
    if (!block || typeof block !== 'object') fail(`${at} is not a block`);
    if (block.id !== undefined && !isText(block.id)) fail(`${at}.id must be text`);
    switch (block.kind) {
      case 'stat':
        if (!isText(block.label) || !(isText(block.value) || typeof block.value === 'number')) fail(`${at} needs a label and a value`);
        break;
      case 'card':
        if (!isText(block.title)) fail(`${at} needs a title`);
        if (block.text !== undefined && !isText(block.text)) fail(`${at}.text must be text`);
        if (block.blocks !== undefined) checkBlocks(block.blocks, actions, `${at}.blocks`);
        break;
      case 'table':
        if (!Array.isArray(block.columns) || !block.columns.every(isText)) fail(`${at} needs columns`);
        if (!Array.isArray(block.rows) || !block.rows.every((r) => Array.isArray(r))) fail(`${at} needs rows`);
        break;
      case 'button':
        if (!isText(block.label) || !isText(block.action)) fail(`${at} needs a label and an action`);
        if (!actions.has(block.action)) fail(`${at}: action "${block.action}" is not in the Manifest's provides.actions`);
        break;
      default:
        fail(`${at}: unknown kind "${String((block as { kind?: unknown }).kind)}"`);
    }
  }
}

/** Checks a Widget's panel content against the panel contract and its Manifest's actions. */
function checkContent(content: unknown, actions: Set<string>): PanelContent {
  if (!content || typeof content !== 'object') fail('Panel content must be an object with blocks');
  if (Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT_BYTES) fail(`Panel content is over ${MAX_CONTENT_BYTES} bytes`);
  checkBlocks((content as PanelContent).blocks, actions, 'blocks');
  return { blocks: (content as PanelContent).blocks };
}

export const pagePath = (widgetId: string, panelId: string) =>
  `/api/widgets/${encodeURIComponent(widgetId)}/pages/${encodeURIComponent(panelId)}/`;

export function createWidgetPanels({ bus, host, widgets }: PanelDeps): WidgetPanels {
  const contents = new Map<string, { content: PanelContent; updatedAt: string }>();
  const key = (widgetId: string, panelId: string) => `${widgetId}\u0000${panelId}`;

  host.onExit((widgetId) => {
    for (const k of [...contents.keys()]) if (k.startsWith(`${widgetId}\u0000`)) contents.delete(k);
  });

  const running = (widgetId: string): WidgetInfo => {
    const widget = widgets().find((w) => w.id === widgetId);
    if (!widget) throw new WidgetHostError(404, `No Widget "${widgetId}" is installed`);
    if (!RUNNING.has(widget.state)) throw new WidgetHostError(409, `Widget "${widgetId}" is not running`);
    return widget;
  };

  const declared = (widget: WidgetInfo, panelId: string): PanelDeclaration => {
    const panel = widget.manifest.provides?.panels?.find((p) => p.id === panelId);
    if (!panel) throw new WidgetHostError(403, `Panel "${panelId}" is not in the Manifest of "${widget.id}"`, 'grant');
    return panel;
  };

  const view = (widget: WidgetInfo, panel: PanelDeclaration): PanelView => {
    const published = contents.get(key(widget.id, panel.id));
    return {
      widgetId: widget.id,
      panelId: panel.id,
      title: panel.title,
      placement: panel.placement ?? 'widgets',
      kind: panel.page ? 'page' : 'declarative',
      content: panel.page ? null : (published?.content ?? null),
      ...(panel.page ? { pageUrl: `${pagePath(widget.id, panel.id)}${encodeURIComponent(basename(panel.page))}` } : {}),
      updatedAt: published?.updatedAt ?? null,
    };
  };

  return {
    list: () =>
      widgets()
        .filter((w) => RUNNING.has(w.state))
        .flatMap((w) => (w.manifest.provides?.panels ?? []).map((p) => view(w, p))),

    publish(widgetId, panelId, content) {
      const widget = running(widgetId);
      const panel = declared(widget, panelId);
      if (panel.page) throw new WidgetHostError(400, `Panel "${panelId}" is an embedded page; it has no declarative content`);
      const checked = checkContent(content, new Set(widget.manifest.provides?.actions ?? []));
      contents.set(key(widgetId, panelId), { content: checked, updatedAt: new Date().toISOString() });
      const panelView = view(widget, panel);
      bus.publish('widget.panel_updated', { widgetId, panelId, panel: panelView });
      return panelView;
    },

    pageMessage(widgetId, panelId, message) {
      const widget = running(widgetId);
      const panel = declared(widget, panelId);
      if (!panel.page) throw new WidgetHostError(400, `Panel "${panelId}" is not an embedded page`);
      bus.publish('widget.page_message', { widgetId, panelId, message });
    },

    action(widgetId, action, request, by) {
      const widget = running(widgetId);
      if (!(widget.manifest.provides?.actions ?? []).includes(action)) {
        throw new WidgetHostError(404, `Widget "${widgetId}" has no action "${action}"`);
      }
      const panelId = request?.panelId ?? null;
      if (panelId !== null) declared(widget, panelId);
      const command: WidgetActionCommand = {
        type: 'widget.action',
        action,
        panelId,
        input: request?.input ?? null,
        by: by.kind === 'kiln' ? { kind: 'kiln' } : { kind: by.kind, id: by.id },
      };
      host.sendCommand(widgetId, command);
    },

    pageFile(widgetId, panelId, relative) {
      const widget = running(widgetId);
      const panel = widget.manifest.provides?.panels?.find((p) => p.id === panelId);
      if (!panel?.page) throw new WidgetHostError(404, `Widget "${widgetId}" has no page "${panelId}"`);
      const root = resolve(widget.folder, dirname(panel.page));
      const file = resolve(root, normalize(relative));
      const inside = file.startsWith(root.endsWith(sep) ? root : root + sep);
      if (!inside || !extname(file) || !existsSync(file) || !statSync(file).isFile()) {
        throw new WidgetHostError(404, `No file ${relative} in the page of "${widgetId}"`);
      }
      return file;
    },
  };
}
