// Widget panels: what a Widget shows in the Shell.
//
// A Manifest declares each panel in `provides.panels`, with where the Shell draws it. A declarative
// panel's content is published by the Widget (`PUT /api/widget/panels/:panelId`, body PanelContent)
// and drawn by the Shell, which patches it whenever the Widget publishes again. A panel with `page`
// is an embedded page instead: the Shell loads it in a sandboxed frame with an opaque origin (no
// access to the Shell's origin, cookies, DOM or other Widgets, and no network), and it talks only
// to its own Widget through the message bridge below.
//
// Button presses and page actions reach the Widget as a `widget.action` command, and only for
// actions its Manifest lists in `provides.actions`.

/**
 * Kept so older Manifests still validate. The Shell no longer reads it: every panel is drawn on its
 * Widget's own page under Widgets (`/widgets/<id>`), never on the home board or a Project page.
 */
export type PanelPlacement = 'home' | 'widgets';

/** One panel in a Manifest's `provides.panels`. */
export interface PanelDeclaration {
  /** Unique within the Widget: lowercase letters, digits and dashes. */
  id: string;
  title: string;
  /** Ignored by the Shell (see PanelPlacement). Default `widgets`. */
  placement?: PanelPlacement;
  /**
   * An embedded page instead of declarative content: an HTML file's path in the Widget's folder,
   * e.g. `ui/index.html`. Files next to it (scripts, styles) are served too.
   */
  page?: string;
}

/** A number or short text with a label, e.g. "VRAM 12.1 GB". */
export interface StatBlock {
  kind: 'stat';
  /** Lets the Shell keep the same element across updates. Optional on every block. */
  id?: string;
  label: string;
  value: string | number;
  unit?: string;
}

export interface CardBlock {
  kind: 'card';
  id?: string;
  title: string;
  text?: string;
  blocks?: PanelBlock[];
  /**
   * Machine-readable values beside the display text, for other parts of Kiln to read; the Shell
   * doesn't draw them. E.g. the GPU monitor's `{ memoryUsedMiB, memoryTotalMiB }` for each GPU.
   */
  data?: Record<string, string | number | boolean | null>;
}

export interface TableBlock {
  kind: 'table';
  id?: string;
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** Runs one of the Widget's named actions when pressed. */
export interface ButtonBlock {
  kind: 'button';
  id?: string;
  label: string;
  /** Must be in the Manifest's `provides.actions`. */
  action: string;
  /** Sent with the action. */
  input?: unknown;
}

export type PanelBlock = StatBlock | CardBlock | TableBlock | ButtonBlock;

/** A declarative panel's content, as the Widget publishes it (whole, each time). */
export interface PanelContent {
  blocks: PanelBlock[];
}

/** Builders for panel blocks, e.g. `panel(block.stat('GPU use', 40, '%'), block.button('Refresh', 'refresh'))`. */
export const block = {
  stat: (label: string, value: string | number, unit?: string): StatBlock => ({ kind: 'stat', label, value, ...(unit ? { unit } : {}) }),
  card: (title: string, more: { text?: string; blocks?: PanelBlock[] } = {}): CardBlock => ({ kind: 'card', title, ...more }),
  table: (columns: string[], rows: TableBlock['rows'], title?: string): TableBlock => ({
    kind: 'table',
    columns,
    rows,
    ...(title ? { title } : {}),
  }),
  button: (label: string, action: string, input?: unknown): ButtonBlock => ({
    kind: 'button',
    label,
    action,
    ...(input !== undefined ? { input } : {}),
  }),
};

export const panel = (...blocks: PanelBlock[]): PanelContent => ({ blocks });

/** A panel as the Shell sees it (`GET /api/panels`, `widget.panel_updated`). */
export interface PanelView {
  widgetId: string;
  panelId: string;
  title: string;
  placement: PanelPlacement;
  kind: 'declarative' | 'page';
  /** Declarative only: null until the Widget publishes. */
  content: PanelContent | null;
  /** Page only: where the Shell loads it from. */
  pageUrl?: string;
  updatedAt: string | null;
}

/** `POST /api/widgets/:id/actions/:action`: a person pressed a button, or a page asked. */
export interface ActionRequest {
  panelId?: string;
  input?: unknown;
}

/** The command a Widget gets for an action. `by` is who pressed it. */
export interface WidgetActionCommand {
  type: 'widget.action';
  action: string;
  panelId: string | null;
  input: unknown;
  by: { kind: string; id?: string };
}

/**
 * The message bridge between an embedded page and the Shell (`window.postMessage`):
 * - page to Shell: `{ kiln: 'action', action, input? }` runs one of its Widget's actions.
 * - Shell to page: `{ kiln: 'message', message }`, for each `POST /api/widget/panels/:panelId/messages`
 *   the Widget sends (body: any JSON message).
 * The Shell accepts messages only from that panel's frame and only for that panel's Widget.
 */
export type PageToShell = { kiln: 'action'; action: string; input?: unknown };
export type ShellToPage = { kiln: 'message'; message: unknown };
