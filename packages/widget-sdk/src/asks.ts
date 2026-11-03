// Asks and Needs you: a person's input, requested by a Session (through its Kiln tools) or a Widget.
import type { Actor, KilnEvent } from './index.ts';
import type { Proposal, ProposalOutcome } from './project-thread.ts';

export type AskType = 'decision' | 'permission' | 'review' | 'question';

export const ASK_TYPES: readonly AskType[] = ['decision', 'permission', 'review', 'question'];

/** What raises an Ask (a Session through its Kiln tools, or a Widget through the Widget API). */
export interface RaiseAskRequest {
  type: AskType;
  /** What the person is asked, e.g. "Use SQLite or Postgres?". */
  question: string;
  /** Why it matters: what depends on the answer. */
  why: string;
  /** The recommended answer. A non-blocking Ask's Session carries on with it. */
  recommendation: string;
  /** Answers to pick from, when the Ask has a fixed set. Free text otherwise. */
  options?: string[];
  /** A blocking Ask pauses its Session until answered. Permission Asks always block. */
  blocking: boolean;
}

/** `POST /api/widget/asks`: a Widget names the Item its Ask is about. */
export interface WidgetRaiseAskRequest extends RaiseAskRequest {
  itemId: string;
}

/**
 * `budget`: Kiln itself, when a Budget cap is reached and the work it covers is paused. `gate`: a
 * Gate raises its Item's Review Ask, and the Decision Ask when merging fails; `stage` is the Gate's Stage.
 * `runaway`: Kiln itself, when the stall rule pauses a Session.
 */
export type AskRaiser =
  | { kind: 'session'; sessionId: string }
  | { kind: 'widget'; widgetId: string }
  | { kind: 'budget'; budgetId: string }
  | { kind: 'gate'; stage: string }
  | { kind: 'runaway'; sessionId: string };

/**
 * What a Gate's Review Ask shows: the artifact the Gate is about (a Ticket's review findings, a
 * Story's spec or its Ticket list) and what the branch changes.
 */
export interface ReviewDetails {
  /** What `findings` holds, as a heading: `Review findings`, `Spec` or `Tickets`. Unset: `Review findings`. */
  artifact?: string;
  /** The artifact's content, as the Stage's Session committed it on the branch. */
  findings: string;
  /** Where the artifact lives in the repo (and in the merged branch); empty for a Ticket list. */
  findingsPath: string;
  /** `git diff --stat` of the branch against where it left the default branch. */
  diffSummary: string;
  branch: string;
  /** The default branch the branch merges into on approval. */
  base: string;
}

/** A Review Ask's answers. Rejecting needs a comment, which goes to the fresh Session doing the rework. */
export const GATE_APPROVE = 'Approve';
export const GATE_REJECT = 'Reject';
/** A merge conflict's Decision Ask: its recommended fix, and the other answer. */
export const CONFLICT_REBASE = 'Rebase in a fresh Implementing Session';
export const CONFLICT_LEAVE = 'I will fix it myself, then approve again';

/** `open` until a person answers. A non-blocking Ask's answer can still change while its raiser runs. */
export type AskState = 'open' | 'answered';

export interface Ask extends RaiseAskRequest {
  /** `ask-<uuid>` */
  id: string;
  itemId: string;
  projectId: string;
  raisedBy: AskRaiser;
  raisedAt: string;
  state: AskState;
  /**
   * How much work the Ask blocks, which Needs you sorts by (most first, then oldest first): the Items
   * waiting on it (its Item and every not-shipped Item under it) plus the Sessions waiting on it.
   * A non-blocking Ask blocks nothing, so it is 0.
   */
  blocks: number;
  /** Set on a Gate's Review Ask. */
  review?: ReviewDetails;
  answer?: string;
  /** The comment given with the answer (needed to reject a Gate). */
  comment?: string;
  answeredAt?: string;
  answeredBy?: Actor;
  /** Set on the Permission Asks Kiln raises for an Agent's `permission_request`. */
  permission?: PermissionRequestRef;
  /**
   * Set on a Project Thread Session's proposal (a Decision Ask to Accept or Decline, answered once).
   * Its `itemId` is then the Project Thread's id (`project:<projectId>`).
   */
  proposal?: Proposal;
  /** What accepting the proposal did. */
  applied?: ProposalOutcome;
}

/** The Agent request a Permission Ask answers. */
export interface PermissionRequestRef {
  sessionId: string;
  requestId: string;
  /** A Policy action, or whatever the Agent named when it is not one. */
  action: string;
  /** The command, domain or path. */
  detail: string;
}

/**
 * The answers of a Permission Ask. "Always allow" writes a narrow allow rule into the Project
 * Policy file; it is left out when the Org or Stage Policy would still ask or deny.
 */
export const PERMISSION_ANSWERS = { once: 'Allow once', always: 'Always allow', deny: 'Deny' } as const;

/** `POST /api/asks/:id/answer` */
export interface AnswerAskRequest {
  answer: string;
  /** Rejecting a Gate needs one: what to change. */
  comment?: string;
}

/** Needs you order: the Ask blocking the most work first, ties broken by age (oldest first). */
export const needsYouOrder = (a: Ask, b: Ask) => b.blocks - a.blocks || a.raisedAt.localeCompare(b.raisedAt) || a.id.localeCompare(b.id);

/** Sent on every SSE connection after `work.snapshot`: every open Ask. */
export type AsksSnapshotEvent = KilnEvent<'asks.snapshot', { asks: Ask[] }>;
export type AskRaisedEvent = KilnEvent<'ask.raised', { ask: Ask; itemId: string; projectId: string }>;
/** Answered, or its answer changed. */
export type AskAnsweredEvent = KilnEvent<'ask.answered', { ask: Ask; itemId: string; projectId: string }>;
/** Something else about an open Ask changed, such as how much work it blocks. */
export type AskUpdatedEvent = KilnEvent<'ask.updated', { ask: Ask; itemId: string; projectId: string }>;
