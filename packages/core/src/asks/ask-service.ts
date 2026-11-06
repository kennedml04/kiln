// The Ask service: creates and answers Asks, keeps them in SQLite, and hands each answer to whatever
// raised the Ask (a Session or a Widget). Needs you is its open Asks in `needsYouOrder`.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  ASK_TYPES,
  needsYouOrder,
  type Actor,
  type Ask,
  type AskRaiser,
  chatOfThread,
  type Item,
  projectOfThread,
  PROPOSAL_ANSWERS,
  PROPOSAL_KINDS,
  type PermissionRequestRef,
  type PermissionReview,
  type Proposal,
  type ProposalOutcome,
  type RaiseAskRequest,
  type ReviewDetails,
} from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { WorkError, type Work } from '../work/work.ts';

/** Takes answers for one kind of raiser. */
export interface AskRecipient {
  /** Whether the raiser can still take an answer (a running Session, a ready Widget). */
  reaches(raiser: AskRaiser): boolean;
  /** `changed`: the answer replaces an earlier one, or the recommendation a non-blocking Ask went on with. */
  deliver(ask: Ask, changed: boolean): void;
  /**
   * Runs before an answer is kept, and may refuse it by throwing (e.g. "Always allow" can't write
   * its rule, or a Gate is rejected without a comment).
   */
  prepare?(ask: Ask, answer: string, by: Actor, comment: string | undefined): void;
}

/** Applies an accepted proposal as the person who accepted it; throwing refuses the answer. */
export type ProposalApplier = (ask: Ask & { proposal: Proposal }, by: Actor) => Promise<ProposalOutcome>;

export interface AskService {
  /**
   * Raises an Ask on an Item, or on a Project Thread (`project:<projectId>`). 400 for a malformed
   * request, 404 for an unknown Item or Project. `permission` is only for the Permission Asks Kiln
   * raises itself for an Agent's permission request; `review` only for a Gate's Review Ask. A
   * `proposal` is only for a Project Thread: it makes the Ask a Decision to Accept or Decline.
   */
  raise(
    request: RaiseAskRequest & {
      itemId: string;
      raisedBy: AskRaiser;
      permission?: PermissionRequestRef;
      review?: ReviewDetails;
      proposal?: unknown;
      permissionReview?: PermissionReview;
    },
  ): Ask;
  /**
   * Answers an Ask and delivers the answer. A non-blocking Ask can be answered again while its
   * raiser still runs; anything else already answered is 409, and so is a proposal's second answer.
   * Accepting a proposal applies it first (whether or not its raiser still runs); if applying fails,
   * the answer is refused and the Ask stays open.
   */
  answer(id: string, answer: string, by: Actor, comment?: string): Promise<Ask>;
  setProposalApplier(applier: ProposalApplier): void;
  get(id: string): Ask | undefined;
  /** Asks, newest state from SQLite: open ones in Needs you order by default. */
  list(filter?: { state?: Ask['state'] | 'all'; itemId?: string }): Ask[];
  /** The open blocking Asks a Session raised. */
  openBlocking(sessionId: string): Ask[];
  /**
   * Says which work waits on an Ask besides its own Item, for its Needs you count: e.g. every Item
   * and Session a Budget hold paused. Replaces what was said before.
   */
  setWaiting(id: string, waiting: Waiting): void;
  setRecipient(kind: AskRaiser['kind'], recipient: AskRecipient): void;
}

/** Work waiting on an Ask: these Items (with the not-shipped Items under them) and this many Sessions. */
export interface Waiting {
  itemIds: Iterable<string>;
  sessions: number;
}

const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** Checks a raise request; returns the clean request or throws 400. */
export function validateRaise(input: unknown): RaiseAskRequest {
  const r = (input ?? {}) as Record<string, unknown>;
  if (!ASK_TYPES.includes(r.type as Ask['type'])) throw new WorkError(400, `An Ask's type is one of ${ASK_TYPES.join(', ')}`);
  for (const field of ['question', 'why', 'recommendation'] as const) {
    if (!nonEmpty(r[field])) throw new WorkError(400, `An Ask needs "${field}"`);
  }
  if (typeof r.blocking !== 'boolean') throw new WorkError(400, 'An Ask must say whether it blocks ("blocking": true or false)');
  if (r.type === 'permission' && !r.blocking) throw new WorkError(400, 'Permission Asks always block');
  if (r.options !== undefined && (!Array.isArray(r.options) || r.options.length === 0 || !r.options.every(nonEmpty))) {
    throw new WorkError(400, '"options" must be a non-empty list of answers');
  }
  return {
    type: r.type as Ask['type'],
    question: String(r.question),
    why: String(r.why),
    recommendation: String(r.recommendation),
    ...(r.options ? { options: (r.options as string[]).map(String) } : {}),
    blocking: r.blocking,
  };
}

/** Checks a proposal's shape (what it names is checked when it is applied); returns it or throws 400. */
export function validateProposal(input: unknown): Proposal {
  const p = (input ?? {}) as Record<string, unknown>;
  if (!PROPOSAL_KINDS.includes(p.kind as Proposal['kind'])) {
    throw new WorkError(400, `A proposal's kind is one of ${PROPOSAL_KINDS.join(', ')}`);
  }
  if (p.kind === 'create_items') {
    const items = p.items;
    if (!Array.isArray(items) || items.length === 0) throw new WorkError(400, 'A create_items proposal lists the Items to create');
    return {
      kind: 'create_items',
      items: items.map((raw) => {
        const i = (raw ?? {}) as Record<string, unknown>;
        if (!nonEmpty(i.kind) || !nonEmpty(i.title)) throw new WorkError(400, 'Each proposed Item needs a "kind" and a "title"');
        return {
          kind: String(i.kind),
          title: String(i.title),
          ...(nonEmpty(i.parentId) ? { parentId: String(i.parentId) } : {}),
          ...(nonEmpty(i.description) ? { description: String(i.description) } : {}),
        };
      }),
    };
  }
  const order = p.order;
  if (!Array.isArray(order) || order.length === 0 || !order.every(nonEmpty)) {
    throw new WorkError(400, 'A reorder_queue proposal gives the Up next order as a list of Item ids');
  }
  return { kind: 'reorder_queue', order: order.map(String) };
}

/** Adds the Items waiting on an Ask through `itemId` to `into`: it and every not-shipped Item under it. */
function waitingItems(items: Map<string, Item>, itemId: string, into: Set<string>): Set<string> {
  const item = items.get(itemId);
  if (!item || item.runState === 'shipped' || into.has(itemId)) return into;
  into.add(itemId);
  for (const child of item.childIds) waitingItems(items, child, into);
  return into;
}

const ITEM_EVENTS = new Set(['item.created', 'item.updated', 'item.removed', 'item.stage_changed']);

export function createAskService({ db, bus, work }: { db: DatabaseSync; bus: EventBus; work: Work }): AskService {
  const insert = db.prepare('INSERT INTO asks (id, item_id, project_id, state, raised_at, ask) VALUES (?, ?, ?, ?, ?, ?)');
  const save = db.prepare('UPDATE asks SET state = ?, ask = ? WHERE id = ?');
  const selectOne = db.prepare('SELECT ask FROM asks WHERE id = ?');
  const selectAll = db.prepare('SELECT ask FROM asks ORDER BY raised_at, id');
  const selectOpen = db.prepare(`SELECT ask FROM asks WHERE state = 'open'`);
  const recipients = new Map<AskRaiser['kind'], AskRecipient>();
  let applier: ProposalApplier | undefined;
  /** Proposal Asks whose acceptance is being applied, so a second answer can't apply it twice. */
  const applying = new Set<string>();
  const parse = (rows: unknown[]) => (rows as { ask: string }[]).map((row) => JSON.parse(row.ask) as Ask);

  /** Work an Ask's raiser says waits on it beyond its own Item (a Budget hold's paused Sessions). */
  const waitingOn = new Map<string, Waiting>();

  const blocks = (ask: Pick<Ask, 'blocking' | 'itemId' | 'raisedBy'> & { id?: string }) => {
    if (!ask.blocking) return 0;
    const items = new Map(work.items().map((item) => [item.id, item]));
    const waiting = ask.id ? waitingOn.get(ask.id) : undefined;
    const itemIds = waitingItems(items, ask.itemId, new Set());
    for (const id of waiting?.itemIds ?? []) waitingItems(items, id, itemIds);
    const sessions = waiting ? waiting.sessions : ask.raisedBy.kind === 'session' || ask.raisedBy.kind === 'runaway' ? 1 : 0;
    return itemIds.size + sessions;
  };

  const store = (ask: Ask) => save.run(ask.state, JSON.stringify(ask), ask.id);
  const ref = (ask: Ask) => ({ ask, itemId: ask.itemId, projectId: ask.projectId });
  const recount = (ask: Ask) => {
    const now = blocks(ask);
    if (now === ask.blocks) return;
    const next = { ...ask, blocks: now };
    store(next);
    bus.publish('ask.updated', ref(next));
  };

  // How much work an open Ask blocks changes as Items are added, removed or shipped.
  bus.subscribe((event) => {
    if (!ITEM_EVENTS.has(event.type)) return;
    for (const ask of parse(selectOpen.all())) recount(ask);
  });

  const get = (id: string) => {
    const row = selectOne.get(id) as { ask: string } | undefined;
    return row ? (JSON.parse(row.ask) as Ask) : undefined;
  };

  return {
    raise(request) {
      const clean = validateRaise(request);
      const threadOf = projectOfThread(request.itemId);
      // A Scratch chat belongs to no Project: its Asks carry an empty projectId.
      const chat = chatOfThread(request.itemId) !== undefined;
      const projectId = chat ? '' : threadOf !== undefined ? work.project(threadOf)?.id : work.item(request.itemId)?.projectId;
      if (projectId === undefined || (!projectId && !chat)) throw new WorkError(404, threadOf !== undefined ? `No Project "${threadOf}"` : `No Item "${request.itemId}"`);
      let proposed: Partial<Ask> = {};
      if (request.proposal !== undefined) {
        if (threadOf === undefined || chat) throw new WorkError(400, 'Only a Project Thread Session makes proposals');
        const options: string[] = [PROPOSAL_ANSWERS.accept, PROPOSAL_ANSWERS.decline];
        proposed = {
          type: 'decision',
          options,
          recommendation: options.includes(clean.recommendation) ? clean.recommendation : PROPOSAL_ANSWERS.accept,
          proposal: validateProposal(request.proposal),
        };
      }
      const base = {
        ...clean,
        ...proposed,
        itemId: request.itemId,
        raisedBy: request.raisedBy,
        ...(request.permission ? { permission: request.permission } : {}),
        ...(request.review ? { review: request.review } : {}),
        ...(request.permissionReview ? { permissionReview: request.permissionReview } : {}),
      };
      const ask: Ask = {
        id: `ask-${randomUUID()}`,
        ...base,
        projectId,
        raisedAt: new Date().toISOString(),
        state: 'open',
        blocks: blocks(base),
      };
      insert.run(ask.id, ask.itemId, ask.projectId, ask.state, ask.raisedAt, JSON.stringify(ask));
      bus.publish('ask.raised', ref(ask));
      return ask;
    },

    async answer(id, answer, by, comment) {
      const ask = get(id);
      if (!ask) throw new WorkError(404, `No Ask "${id}"`);
      if (!nonEmpty(answer)) throw new WorkError(400, 'An answer cannot be empty');
      if (ask.options && !ask.options.includes(answer)) {
        throw new WorkError(400, `Answer with one of: ${ask.options.join(', ')}`);
      }
      const recipient = recipients.get(ask.raisedBy.kind);
      const reachable = recipient?.reaches(ask.raisedBy) ?? false;
      if (ask.state === 'answered' && (ask.blocking || !reachable || ask.proposal)) {
        throw new WorkError(
          409,
          ask.blocking || ask.proposal ? 'This Ask is already answered' : 'Whatever raised this Ask has finished, so its answer can no longer change',
        );
      }
      const note = nonEmpty(comment) ? comment!.trim() : undefined;
      if (reachable) recipient!.prepare?.(ask, answer, by, note);
      let applied: ProposalOutcome | undefined;
      if (ask.proposal) {
        if (applying.has(ask.id)) throw new WorkError(409, 'This Ask is already being answered');
        applying.add(ask.id);
        try {
          if (answer === PROPOSAL_ANSWERS.accept) {
            if (!applier) throw new WorkError(503, 'Kiln cannot apply proposals right now');
            applied = await applier({ ...ask, proposal: ask.proposal }, by);
          }
        } finally {
          applying.delete(ask.id);
        }
      }
      const before = ask.answer ?? (ask.blocking ? undefined : ask.recommendation);
      const next: Ask = {
        ...ask,
        state: 'answered',
        answer,
        ...(note ? { comment: note } : {}),
        answeredAt: new Date().toISOString(),
        answeredBy: by,
        blocks: 0,
        ...(applied ? { applied } : {}),
      };
      store(next);
      bus.publish('ask.answered', ref(next));
      if (reachable) recipient!.deliver(next, before !== undefined && before !== answer);
      return next;
    },

    get,

    list(filter = {}) {
      const state = filter.state ?? 'open';
      const asks = parse(selectAll.all()).filter(
        (ask) => (state === 'all' || ask.state === state) && (!filter.itemId || ask.itemId === filter.itemId),
      );
      return state === 'open' ? asks.sort(needsYouOrder) : asks;
    },

    openBlocking(sessionId) {
      return parse(selectOpen.all()).filter(
        (ask) => ask.blocking && ask.raisedBy.kind === 'session' && ask.raisedBy.sessionId === sessionId,
      );
    },

    setWaiting(id, waiting) {
      waitingOn.set(id, { itemIds: [...waiting.itemIds], sessions: waiting.sessions });
      const ask = get(id);
      if (ask?.state === 'open') recount(ask);
    },

    setRecipient(kind, recipient) {
      recipients.set(kind, recipient);
    },

    setProposalApplier(next) {
      applier = next;
    },
  };
}
