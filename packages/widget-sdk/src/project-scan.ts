// The Import scan (`POST /api/projects/scan`, Admin) and what Import writes from it. The scan only
// reads files: it never runs a command, the repo's or git's, and no AI looks at the folder.
import type { RepoRefusal } from './work.ts';

/** POST /api/projects/scan */
export interface ProjectScanRequest {
  /** The folder to scan, absolute. */
  path: string;
}

/** A doc Import looks for. `agents` is found when either AGENTS.md or CLAUDE.md is there. */
export type ScanDocId = 'scratch' | 'adr' | 'glossary' | 'agents';

export interface ScanDoc {
  id: ScanDocId;
  /** What the person sees, e.g. `.scratch/` or `AGENTS.md / CLAUDE.md`. */
  name: string;
  found: boolean;
  /** The files or folders it found, repo-relative (`AGENTS.md`, `CLAUDE.md`, ...). */
  paths: string[];
}

/** A test command guessed from a file; the person confirms one (or types their own). */
export interface TestCommandGuess {
  command: string;
  /** The file it came from: `package.json`, `pyproject.toml` or `Makefile`. */
  source: string;
  /** Why, e.g. `the "test" script`. */
  why: string;
}

/** A module the Project could pull in. */
export interface ScanModule {
  id: string;
  name: string;
  description: string;
  /** One of its `detect` globs matched a file. */
  suggested: boolean;
  /** Up to a few files that matched, repo-relative with `/`. */
  matches: string[];
}

/** The folder's git state, read from its `.git` files. */
export interface ScanGit {
  /** `ready` when Register would take it as it is; otherwise why Register refuses it. */
  state: 'ready' | RepoRefusal;
  /** The branch checked out; null on a detached HEAD; absent outside a repo. */
  branch?: string | null;
  /** The branch work merges into, when it is a repo. */
  defaultBranch?: string;
  /** What it means for the person. */
  message: string;
}

export interface ProjectScan {
  path: string;
  docs: ScanDoc[];
  testCommands: TestCommandGuess[];
  /** Every module available to the folder, suggested ones first. */
  modules: ScanModule[];
  git: ScanGit;
  /** The `.kiln/settings.json` already there, when it has a test command or modules. */
  settings: { testCommand?: string; modules?: string[] };
}

/**
 * What Import adds to `POST /api/projects` (`RegisterProjectRequest`). The test command and the
 * modules go into `.kiln/settings.json` in one commit; `onboard` creates the Onboard Story listing
 * the docs the scan found missing. With none of them, registering writes nothing else.
 */
export interface ImportOptions {
  testCommand?: string;
  modules?: string[];
  onboard?: boolean;
}
