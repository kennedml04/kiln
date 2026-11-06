// Core API routes for Sessions and Threads.
//   POST /api/items/:id/start    starts a fresh Session for the Item's current Stage when its pool has room
//                                -> 201 StartResult, or queues it in Up next -> 202 StartResult
//   GET  /api/items/:id/thread   the Item's Thread (ThreadEntry[])
//   POST /api/items/:id/messages {text} a person's Thread message -> 201 ThreadMessageResult: into the
//                                running Session, resuming the last one while its Agent's cache is
//                                warm, or a fresh one (202 when that waits in Up next)
//   GET  /api/items/:id/digests  the Item's Digests from the Knowledge store, oldest first (Digest[])
//   GET  /api/projects/:id/thread    the Project Thread (ThreadEntry[])
//   POST /api/projects/:id/messages  {text} a person's message in the Project Thread -> 201
//                                ThreadMessageResult: into its live Session, resuming the last one while
//                                warm, or a fresh read-only Project Thread Session (no pool slot)
//   GET  /api/projects/:id/digests   the Project Thread's Digests, oldest first (Digest[])
//   GET  /api/sessions[?item=id] SessionInfo[] (a Project Thread's Sessions: item=project:<id>)
//   GET  /api/sessions/:id       SessionInfo
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectThreadId, type StartResult, type ThreadEntry, type ThreadMessageRequest, type ThreadMessageResult } from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { Scheduler } from './scheduler.ts';
import type { SessionManager } from './session-manager.ts';

const ITEM_ACTION = /^\/api\/items\/([^/]+)\/(start|thread|messages|digests)$/;
const PROJECT_THREAD = /^\/api\/projects\/([^/]+)\/(thread|messages|digests)$/;
const SESSION = /^\/api\/sessions\/([^/]+)$/;

/** Answers the request if it is a Session route; returns false otherwise. */
export async function handleFlowRoute(
  sessions: SessionManager,
  scheduler: Scheduler,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
  /** Filters an Item's Thread for the caller (hides links to chats they cannot open). */
  threadFor: (entries: ThreadEntry[]) => ThreadEntry[] = (entries) => entries,
): Promise<boolean> {
  try {
    const action = ITEM_ACTION.exec(url.pathname);
    if (action) {
      const itemId = decodeURIComponent(action[1]!);
      if (action[2] === 'start' && req.method === 'POST') {
        const result = await scheduler.enqueue(itemId);
        return (sendJson(res, result.queued ? 202 : 201, result), true);
      }
      if (action[2] === 'thread' && req.method === 'GET') return (sendJson(res, 200, threadFor(sessions.thread(itemId))), true);
      if (action[2] === 'digests' && req.method === 'GET') return (sendJson(res, 200, sessions.digests(itemId)), true);
      if (action[2] === 'messages' && req.method === 'POST') {
        const { text } = ((await readJson(req)) ?? {}) as Partial<ThreadMessageRequest>;
        // While Stop all is on nothing resumes; a fresh start waits in Up next.
        const delivered = sessions.message(itemId, text as string, { resume: !scheduler.state().paused });
        if (delivered) return (sendJson(res, 201, delivered), true);
        let started: StartResult;
        try {
          // A person is in the Thread: the start is attended, so the pace rule lets it through.
          started = await scheduler.enqueue(itemId, { attended: true });
        } catch (err) {
          sessions.dropHeld(itemId);
          throw err;
        }
        const result: ThreadMessageResult = started.session
          ? { delivery: 'fresh', sessionId: started.session.id }
          : { delivery: 'queued' };
        return (sendJson(res, started.queued ? 202 : 201, result), true);
      }
    }
    const projectAction = PROJECT_THREAD.exec(url.pathname);
    if (projectAction) {
      const threadId = projectThreadId(decodeURIComponent(projectAction[1]!));
      if (projectAction[2] === 'thread' && req.method === 'GET') return (sendJson(res, 200, sessions.thread(threadId)), true);
      if (projectAction[2] === 'digests' && req.method === 'GET') return (sendJson(res, 200, sessions.digests(threadId)), true);
      if (projectAction[2] === 'messages' && req.method === 'POST') {
        const { text } = ((await readJson(req)) ?? {}) as Partial<ThreadMessageRequest>;
        const delivered = sessions.message(threadId, text as string, { resume: !scheduler.state().paused });
        if (delivered) return (sendJson(res, 201, delivered), true);
        // A Project Thread Session only reads, so it starts at once and takes no pool slot.
        let started;
        try {
          if (scheduler.state().paused) throw new WorkError(409, 'Stop all is on: no Session starts until you resume');
          started = await sessions.start(threadId);
        } catch (err) {
          sessions.dropHeld(threadId);
          throw err;
        }
        const result: ThreadMessageResult = { delivery: 'fresh', sessionId: started.id };
        return (sendJson(res, 201, result), true);
      }
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      return (sendJson(res, 200, sessions.sessions(url.searchParams.get('item') ?? undefined)), true);
    }
    const session = SESSION.exec(url.pathname);
    if (session && req.method === 'GET') {
      const found = sessions.session(decodeURIComponent(session[1]!));
      if (!found) throw new WorkError(404, `No Session "${session[1]}"`);
      return (sendJson(res, 200, found), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
