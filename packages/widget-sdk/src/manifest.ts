// The Manifest: a Widget's declaration of what it provides, what it needs
// and which core API versions it supports. It lives in the Widget's folder
// as `kiln-widget.json`.

import type { PanelDeclaration } from './panel.ts';

export const MANIFEST_FILE = 'kiln-widget.json';

/** An Agent a Widget provides (ADR 0004). */
export interface AgentProvision {
  /** Unique within the Widget, e.g. "claude-code". */
  id: string;
  name: string;
}

export interface WidgetProvides {
  agents?: AgentProvision[];
  /** Panels the Shell draws for it (see panel.ts). */
  panels?: PanelDeclaration[];
  /** Trackers it keeps Item records in, by the id a Project's `tracker` setting names (see tracker-widget.ts). */
  trackers?: string[];
  /** Hosts it opens pull requests on for PR-mode Projects, e.g. `github` (see tracker-widget.ts). */
  pullRequests?: string[];
  knowledgeStores?: string[];
  /** Capacity pools the Widget adds, e.g. `{ "gpu": 1 }`. */
  pools?: Record<string, number>;
  /** Named actions panel buttons can call. */
  actions?: string[];
}

export interface WidgetNeeds {
  /** Work data the Widget reads or writes, by Project scope. */
  work?: { access: 'read' | 'write'; projects: '*' | string[] }[];
  /** Whether the Widget raises Asks. */
  asks?: boolean;
  /** Network domains it talks to. */
  network?: string[];
  /** Named secrets it needs from the Platform. */
  secrets?: string[];
  /** Whether it needs its own data folder. */
  dataFolder?: boolean;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  /** Where it was installed from (filled in by the install flow). */
  source?: string;
  /** Supported core API range, e.g. "^0.1.0". */
  coreApi: string;
  /**
   * The command that starts it, run in the Widget's folder.
   * A first element of "node" means the Node that runs the core.
   */
  command: string[];
  provides?: WidgetProvides;
  needs?: WidgetNeeds;
}
