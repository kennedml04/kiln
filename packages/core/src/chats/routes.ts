// Core API routes for Scratch chats (Member or Admin; Viewers can read only).
//   GET  /api/chats[?archived=0|1]  the caller's chats, pinned first, then by last message (ScratchChat[])
//   POST /api/chats {text}          opens a chat and starts its Session at once, attended -> 201 OpenChatResult
//   GET  /api/chats/:id             ScratchChat
//   PATCH /api/chats/:id {title?, pinned?, archived?}  rename, pin or archive -> ScratchChat
//   GET  /api/chats/:id/thread      the chat's Thread (ThreadEntry[])
//   GET  /api/chats/:id/digests     the chat's Digests, oldest first (Digest[])
//   POST /api/chats/:id/messages {text}  a message into the chat's Session -> 201 ThreadMessageResult
//   GET|POST|DELETE /api/chats/:id/story-draft  the pending Make it a Story draft; open one {projectId, parentId?}; cancel it
//   POST /api/chats/:id/story {projectId, parentId?, title, description}  Accept: creates the grill-stage Story -> 201 Item
// A chat's Session starts at once: outside the scheduler's pools, the pace rule and the reserves.
// Stop all still holds: while it is on, opening a chat or sending a message is refused with 409.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Actor,
  type Role,
  type ThreadEntry,
  CHAT_STORY_MADE,
  chatThreadId,
  ITEM_FROM_CHAT,
  type MakeStoryRequest,
  type OpenChatResult,
  type OpenStoryDraftRequest, type ThreadMessageRequest, type ThreadMessageResult } from '@kiln/widget-sdk';
import type { Clock } from '../clock.ts';
import type { Access } from '../access.ts';
import type { Scheduler } from '../flow/scheduler.ts';
import type { SessionManager } from '../flow/session-manager.ts';
import { WorkError } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { Work } from '../work/work.ts';
import type { EventBus } from '../events.ts';
import type { Chats } from './chats.ts';
import type { StoryDrafts } from './story-drafts.ts';

const CHAT = /^\/api\/chats\/([^/]+)(?:\/(thread|digests|messages|story-draft|story))?$/;

const STOP_ALL = 'Stop all is on: no Session starts until you resume';

/** Answers the request if it is a chat route; returns false otherwise. */
export async function handleChatRoute(
  chats: Chats,
  sessions: SessionManager,
  scheduler: Scheduler,
  clock: Clock,
  access: Access,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
  story?: { work: Work; drafts: StoryDrafts; bus: EventBus },
): Promise<boolean> {
  try {
    const actor = () => access.caller(req).actor;
    const ownerOf = () => {
      const a = actor();
      return a.kind === 'user' ? a.id : 'local';
    };
    /** Sends a message into the chat's Session, starting a fresh one when none is alive. */
    const deliver = async (id: string, text: string): Promise<ThreadMessageResult> => {
      const threadId = chatThreadId(id);
      if (scheduler.state().paused) throw new WorkError(409, STOP_ALL);
      const delivered = sessions.message(threadId, text, { resume: true });
      if (delivered) {
        chats.touch(id, clock.now());
        return delivered;
      }
      try {
        const started = await sessions.start(threadId);
        chats.touch(id, clock.now());
        return { delivery: 'fresh', sessionId: started.id };
      } catch (err) {
        sessions.dropHeld(threadId);
        throw err;
      }
    };

    if (url.pathname === '/api/chats') {
      if (req.method === 'GET') {
        const archived = url.searchParams.get('archived') === '1';
        // `all=1` lists every person's chats; only an Admin may ask for it.
        if (url.searchParams.get('all') === '1') {
          if (access.caller(req).role !== 'admin') throw new WorkError(403, "Only an Admin can list everyone's chats");
          return (sendJson(res, 200, chats.list({ archived })), true);
        }
        return (sendJson(res, 200, chats.list({ ownerId: ownerOf(), archived })), true);
      }
      if (req.method === 'POST') {
        const { text } = ((await readJson(req)) ?? {}) as Partial<ThreadMessageRequest>;
        if (typeof text !== 'string' || !text.trim()) throw new WorkError(400, 'A chat needs a first message');
        if (scheduler.state().paused) throw new WorkError(409, STOP_ALL);
        const chat = chats.open(ownerOf(), text, clock.now());
        access.note(req, { target: chatThreadId(chat.id) });
        let sessionId: string;
        try {
          sessions.message(chatThreadId(chat.id), text);
          const started = await sessions.start(chatThreadId(chat.id));
          sessionId = started.id;
        } catch (err) {
          sessions.dropHeld(chatThreadId(chat.id));
          chats.remove(chat.id);
          throw err;
        }
        const body: OpenChatResult = { chat: chats.get(chat.id)!, sessionId };
        return (sendJson(res, 201, body), true);
      }
      return false;
    }

    const match = CHAT.exec(url.pathname);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    const chat = chats.get(id);
    if (!chat) throw new WorkError(404, `No chat "${id}"`);
    const part = match[2];
    if (req.method === 'GET') {
      if (!part) return (sendJson(res, 200, chat), true);
      if (part === 'thread') return (sendJson(res, 200, sessions.thread(chatThreadId(id))), true);
      if (part === 'digests') return (sendJson(res, 200, sessions.digests(chatThreadId(id))), true);
    }
    if (req.method === 'PATCH' && !part) {
      const body = ((await readJson(req)) ?? {}) as { title?: unknown; pinned?: unknown; archived?: unknown };
      if (body.title !== undefined && typeof body.title !== 'string') throw new WorkError(400, '"title" must be text');
      if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw new WorkError(400, '"pinned" must be true or false');
      if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new WorkError(400, '"archived" must be true or false');
      access.note(req, { target: chatThreadId(id) });
      if (body.archived === true && !chat.archivedAt) await sessions.endItem(chatThreadId(id), false);
      return (sendJson(res, 200, chats.update(id, body as { title?: string; pinned?: boolean; archived?: boolean }, clock.now())), true);
    }
    if (req.method === 'POST' && part === 'messages') {
      const { text } = ((await readJson(req)) ?? {}) as Partial<ThreadMessageRequest>;
      access.note(req, { target: chatThreadId(id) });
      return (sendJson(res, 201, await deliver(id, text as string)), true);
    }
    if (part === 'story-draft' || part === 'story') {
      if (!story) return false;
      const { work, drafts, bus } = story;
      if (part === 'story-draft' && req.method === 'GET') {
        const draft = drafts.get(id, clock.now());
        if (!draft) throw new WorkError(404, 'No Make it a Story draft is pending');
        return (sendJson(res, 200, draft), true);
      }
      if (part === 'story-draft' && req.method === 'DELETE') {
        access.note(req, { target: chatThreadId(id) });
        drafts.expire(clock.now());
        return (sendJson(res, 200, { cancelled: drafts.close(id, 'cancelled') }), true);
      }
      // The Project and the Epic are checked here so a bad pick fails before the chat is asked.
      const target = (body: Partial<OpenStoryDraftRequest>) => {
        if (typeof body.projectId !== 'string' || !work.project(body.projectId)) throw new WorkError(404, `No Project "${String(body.projectId)}"`);
        const parentId = body.parentId === undefined || body.parentId === null || body.parentId === '' ? undefined : body.parentId;
        if (parentId !== undefined) {
          const parent = typeof parentId === 'string' ? work.item(parentId) : undefined;
          if (!parent || parent.projectId !== body.projectId) throw new WorkError(400, `No parent Item "${String(parentId)}" in this Project`);
        }
        return { projectId: body.projectId, ...(parentId ? { parentId } : {}) };
      };
      if (part === 'story-draft' && req.method === 'POST') {
        const picked = target(((await readJson(req)) ?? {}) as Partial<OpenStoryDraftRequest>);
        access.note(req, { target: chatThreadId(id) });
        const draft = drafts.open(id, picked, clock.now());
        const project = work.project(picked.projectId)!;
        const epic = picked.parentId ? work.item(picked.parentId) : undefined;
        try {
          await deliver(
            id,
            `Make this chat a Story in the Project "${project.name}"${epic ? `, under the Epic "${epic.title}"` : ''}. ` +
              'Call the draft_story tool once with a short title and a short story.md description that sums up what we agreed: ' +
              'a summary written for someone who has not seen this chat, not the transcript. Do not make anything yourself.',
          );
        } catch (err) {
          drafts.close(id, 'cancelled');
          throw err;
        }
        return (sendJson(res, 202, draft), true);
      }
      if (part === 'story' && req.method === 'POST') {
        const body = ((await readJson(req)) ?? {}) as Partial<MakeStoryRequest>;
        const picked = target(body);
        if (typeof body.title !== 'string' || !body.title.trim()) throw new WorkError(400, 'A Story needs a title');
        if (typeof body.description !== 'string') throw new WorkError(400, 'A Story needs a description');
        const draft = drafts.get(id, clock.now());
        if (!draft) throw new WorkError(409, 'No Make it a Story draft is pending (it may have expired after 30 minutes)');
        access.note(req, { target: chatThreadId(id) });
        const created = await work.createItem(picked.projectId, {
          kind: 'story',
          title: body.title.trim(),
          description: body.description,
          ...(picked.parentId ? { parentId: picked.parentId } : {}),
        });
        drafts.close(id, 'accepted');
        // The link is runtime only: the Story's story.md carries no chat reference.
        bus.publish(ITEM_FROM_CHAT, { itemId: created.id, chatId: id });
        bus.publish(CHAT_STORY_MADE, { itemId: chatThreadId(id), chatId: id, storyId: created.id });
        chats.addStory(id, created.id);
        return (sendJson(res, 201, created), true);
      }
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}

/**
 * A Story's Thread as one caller may see it: the "Made from a Scratch chat" entry stays for
 * everyone who can see the Story, but only the chat's owner and Admins keep the chat's id (the link).
 */
export function linkVisibleTo(caller: { actor: Actor; role: Role | null }, chats: Chats, entries: ThreadEntry[]): ThreadEntry[] {
  const me = caller.actor.kind === 'user' ? caller.actor.id : 'local';
  return entries.map((entry) => {
    if (entry.type !== ITEM_FROM_CHAT) return entry;
    const chatId = (entry.payload as { chatId?: string }).chatId;
    const chat = chatId === undefined ? undefined : chats.get(chatId);
    if (chat && (caller.role === 'admin' || chat.ownerId === me)) return entry;
    const { chatId: _hidden, ...rest } = entry.payload as Record<string, unknown>;
    return { ...entry, payload: rest } as ThreadEntry;
  });
}
