// The Project Thread (ticket 13): where a person talks about a Project as a whole. Its Sessions
// read across the Project but run under a read-only Stage Policy; they change nothing themselves
// and propose changes as Asks, which Kiln applies as the accepting person's action.
//
// A Project Thread is not an Item. Its Sessions, Thread entries and Asks carry the Project
// Thread's id where an Item's would carry the Item id (`itemId`), so the Thread, Needs you and the
// Session list work for both. Item ids are `<projectId>/<key>`; a Project Thread id never has a `/`.
import type { CreateItemRequest } from './work.ts';
import type { PolicyLayer } from './policy.ts';

const PREFIX = 'project:';

/** The id a Project Thread's Sessions, Thread entries and Asks carry as their `itemId`. */
export const projectThreadId = (projectId: string) => `${PREFIX}${projectId}`;

/** The Project a Project Thread id belongs to, or undefined for any other id (an Item's). */
export const projectOfThread = (id: string): string | undefined =>
  id.startsWith(PREFIX) && !id.includes('/') ? id.slice(PREFIX.length) : undefined;

/** The Item kind, Stage id and role a Project Thread Session runs as (no Workflow defines them). */
export const PROJECT_THREAD_KIND = 'project-thread';
export const PROJECT_THREAD_STAGE = 'project-thread';
export const PROJECT_THREAD_ROLE = 'project-thread';

/**
 * The Stage Policy every Project Thread Session runs under: it may read the repo and nothing else.
 * Being a Stage layer, it can only tighten the Org and Project layers, so no rule there loosens it.
 */
export const PROJECT_THREAD_POLICY: Required<PolicyLayer> = {
  actions: {
    worktree_write: 'deny',
    known_commands: 'deny',
    other_commands: 'deny',
    network: 'deny',
    external_writes: 'deny',
    outside_worktree: 'deny',
  },
  rules: [],
};

/**
 * A change a Project Thread Session proposes, carried by its Decision Ask (`Ask.proposal`). Kiln
 * applies it only when a person accepts the Ask, as that person.
 * - `create_items`: new Items, created in order (each `parentId` names an existing Item).
 * - `reorder_queue`: a new start order for Up next (the Item ids, first to start first).
 */
export type Proposal =
  | { kind: 'create_items'; items: CreateItemRequest[] }
  | { kind: 'reorder_queue'; order: string[] };

export const PROPOSAL_KINDS: readonly Proposal['kind'][] = ['create_items', 'reorder_queue'];

/** The answers of a proposal Ask. Accepting applies the change; either answer is final. */
export const PROPOSAL_ANSWERS = { accept: 'Accept', decline: 'Decline' } as const;

/** What applying an accepted proposal did, kept on the Ask (`Ask.applied`). */
export interface ProposalOutcome {
  /** The Items created, in order. */
  created?: string[];
  /** Up next's order afterwards. */
  order?: string[];
}
