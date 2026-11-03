// The setup wizard (ticket 25): the first-run settings, what setup detected on this machine, the
// default Budgets it offers, and the one-time import of the old board's Projects.
import type { KilnEvent, LoginMode } from './index.ts';
import type { SetBudgetRequest } from './budgets.ts';
import type { Project } from './work.ts';

/**
 * The public Widget repo the first-party Agent Widgets install from (a git URL). An Admin can
 * point setup elsewhere (a fork or a local copy); that answer is stored as the `widgetRepo`
 * setting, which wins over this.
 */
export const PUBLIC_WIDGET_REPO = 'https://github.com/kennedml04/kiln.git';

/**
 * The old board's data folder, which holds its Project registry (`projects.json`). Spelled in parts:
 * Kiln's code carries none of the old names (see naming.test.ts).
 */
export const OLD_BOARD_DATA_FOLDER = ['gpu', 'board_data'].join('');

/** Shown wherever the Tailscale login mode is chosen or checked. */
export const TAILSCALE_SERVE_WARNING =
  "Don't put `tailscale serve` (or any reverse proxy) in front of Kiln. Its requests reach Kiln from this PC, " +
  'and Kiln treats every request from this PC as the local Admin, so every remote caller would be Admin. ' +
  "Kiln's Tailscale login mode serves the tailnet itself and knows who each caller is.";

/** A work install meters credits; a home install has a Claude Max subscription and maybe local models. */
export type InstallKind = 'work' | 'home';

/** The model (and fallback) a default Workflow role runs on. */
export interface RoleModel {
  model: string;
  /** Offered instead when the model's Budget runs low (e.g. at the Fable reserve). */
  fallbackModel?: string;
  /** The Agent that runs the role. Unset: the first ready Agent. */
  agent?: string;
}

/** What an Admin chose in setup. Every field is optional until it has been chosen. */
export interface SetupSettings {
  /** Takes effect when the core next starts (unless `--login` / `KILN_LOGIN` is given). */
  login?: LoginMode;
  /** The markdown Knowledge store folder. Takes effect at once. */
  knowledgeDir?: string;
  install?: InstallKind;
  /** Where the first-party Agent Widgets come from. Unset: `PUBLIC_WIDGET_REPO`. */
  widgetRepo?: string;
  /** The old board's Project registry (`projects.json` in its data folder, OLD_BOARD_DATA_FOLDER). */
  oldBoardRegistry?: string;
  /** Default Workflow role -> its model. */
  roles?: Record<string, RoleModel>;
}

/** `PUT /api/setup` (Admin): any of the settings; the rest stay as they are. */
export type SetupChange = SetupSettings;

/** A Budget setup offers, ready to send to `PUT /api/budgets/:id`. */
export interface BudgetDraft extends SetBudgetRequest {
  id: string;
}

/** A first-party Agent Widget setup offers to install from the Widget repo. */
export interface FirstPartyAgent {
  id: string;
  name: string;
  /** Its folder in the Widget repo (the install's `path`). */
  path: string;
  /** What it is for, in a few words. */
  about: string;
  /** The installs it is suggested for. */
  suggested: InstallKind[];
  installed: boolean;
}

/** A Project in the old board's registry, as setup would import it. */
export interface OldBoardProject {
  name: string;
  path: string;
  /** Why it won't be imported (missing folder, the old board's own folder), if it won't. */
  skip?: string;
  /** Already registered in Kiln. */
  registered: boolean;
}

/** `GET /api/setup` (Admin). */
export interface SetupState {
  completed: boolean;
  completedAt?: string;
  settings: SetupSettings;
  /** What this core runs with now. */
  running: { login: LoginMode; knowledgeDir: string };
  /** The chosen login mode differs from the running one: restart Kiln to switch. */
  restartNeeded: boolean;
  widgetRepo: string;
  obsidian: {
    installed: boolean;
    /** Where it was found. */
    path?: string;
    /** The Knowledge store folder is already an Obsidian vault (it has `.obsidian`). */
    vault: boolean;
    /** A suggestion to install it, when it isn't. Never required. */
    suggestion?: string;
  };
  tailscale: {
    warning: string;
    /** What `tailscale serve` forwards to Kiln, if it does (it must not). */
    servesKiln?: string;
  };
  localModelServer: { found: boolean; url?: string; models: string[] };
  /** The Budgets each kind of install starts with. Home includes a local Budget only when a local model server was found. */
  defaults: Record<InstallKind, BudgetDraft[]>;
  /** The default Workflow's roles, each with the Stages that use it. */
  roles: { role: string; stages: string[] }[];
  agents: FirstPartyAgent[];
  oldBoard: { registry: string; found: boolean; error?: string; projects: OldBoardProject[] };
}

/** `POST /api/setup/import` (Admin). */
export interface ImportResult {
  imported: Project[];
  skipped: { name: string; path: string; reason: string }[];
}

/** `POST /api/setup/complete` (Admin) refuses with 409 while something required is missing. */
export type SetupCompletedEvent = KilnEvent<'setup.completed', { completedAt: string }>;
