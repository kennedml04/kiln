// Core API routes for Asks (Needs you).
//   GET  /api/asks[?state=open|answered|all][&item=id]  open Asks in Needs you order by default
//   GET  /api/asks/:id
//   POST /api/asks/:id/answer {answer}                  -> the answered Ask (Member; audited as ask.answer)
// Widgets raise Asks with POST /api/widget/asks (see server.ts); Sessions with their Kiln tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GATE_APPROVE, type AnswerAskRequest, type Ask } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { AskService } from './ask-service.ts';

const ASK = /^\/api\/asks\/([^/]+)(\/answer)?$/;
const STATES = new Set(['open', 'answered', 'all']);

/** Answers the request if it is an Ask route; returns false otherwise. */
export async function handleAskRoute(
  asks: AskService,
  access: Access,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  try {
    if (url.pathname === '/api/asks' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      if (!STATES.has(state)) throw new WorkError(400, 'state is open, answered or all');
      const itemId = url.searchParams.get('item') ?? undefined;
      return (sendJson(res, 200, asks.list({ state: state as Ask['state'] | 'all', ...(itemId ? { itemId } : {}) })), true);
    }
    const match = ASK.exec(url.pathname);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    if (!match[2] && req.method === 'GET') {
      const ask = asks.get(id);
      if (!ask) throw new WorkError(404, `No Ask "${id}"`);
      return (sendJson(res, 200, ask), true);
    }
    if (match[2] && req.method === 'POST') {
      const body = ((await readJson(req)) ?? {}) as Partial<AnswerAskRequest>;
      access.note(req, { target: `ask:${id}` });
      const answer = typeof body.answer === 'string' ? body.answer : '';
      const comment = typeof body.comment === 'string' ? body.comment : undefined;
      const answered = await asks.answer(id, answer, access.caller(req).actor, comment);
      // A Gate's answer is audited as the approval or rejection it is.
      const gate = answered.raisedBy.kind === 'gate' && answered.type === 'review';
      access.note(req, {
        ...(gate ? { action: answered.answer === GATE_APPROVE ? 'gate.approve' : 'gate.reject' } : {}),
        detail: { answer: answered.answer, itemId: answered.itemId, ...(answered.comment ? { comment: answered.comment } : {}) },
      });
      return (sendJson(res, 200, answered), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
