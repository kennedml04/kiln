// The Scratch chat (see .scratch/scratch-chat/spec.md): a Session that belongs to no Project and
// no Item, for a one-off question. Each chat is its own small Thread in Kiln's own Item-shaped
// subject `chat:<id>`, the way the Project Thread uses `project:<id>`. A chat has no Stage of a
// Workflow, no worktree and no Exit. Its Sessions run under a read-only Stage Policy like the
// Project Thread's, plus network access, and read every registered Project's checkout through the
// Session's `readRoots`.
import type { PolicyLayer } from './policy.ts';
import { PROJECT_THREAD_POLICY } from './project-thread.ts';

const PREFIX = 'chat:';

/** The id a chat's Sessions, Thread entries and Asks carry as their `itemId`. */
export const chatThreadId = (id: string) => `${PREFIX}${id}`;

/** The chat a Thread id belongs to, or undefined for any other id (an Item's, a Project Thread's). */
export const chatOfThread = (threadId: string): string | undefined =>
  threadId.startsWith(PREFIX) && !threadId.includes('/') && threadId.length > PREFIX.length ? threadId.slice(PREFIX.length) : undefined;

/** The Item kind, Stage id and role a Scratch chat Session runs as (no Workflow defines them). */
export const CHAT_KIND = 'chat';
export const CHAT_STAGE = 'chat';
export const CHAT_ROLE = 'chat';

/**
 * The Stage Policy every Scratch chat Session runs under: the Project Thread's read-only Policy
 * with the network allowed. Being a Stage layer it can only tighten the Org layer, so an Org
 * Policy that denies `network` still wins. Chats raise no Permission Asks: what is not allowed here
 * is `deny`, never `ask`.
 */
export const CHAT_POLICY: Required<PolicyLayer> = {
  actions: { ...PROJECT_THREAD_POLICY.actions, network: 'allow' },
  rules: [],
};

/** A Scratch chat as the API shows it. */
export interface ScratchChat {
  id: string;
  title: string;
  /** The person who opened it. */
  ownerId: string;
  createdAt: string;
  lastMessageAt: string;
  pinned: boolean;
  /** Set once the chat has been archived. */
  archivedAt?: string;
  /** The Items made from it (Make it a Story). */
  stories: string[];
  /** Whether a Session of the chat is alive now. */
  running: boolean;
}

/** POST /api/chats: the first message starts the chat's Session. */
export interface OpenChatRequest {
  text: string;
}

/** POST /api/chats answers with this (201). */
export interface OpenChatResult {
  chat: ScratchChat;
  sessionId: string;
}

/** A pending Make it a Story draft (`GET /api/chats/:id/story-draft`). Title and description are set once the chat fills it. */
export interface ChatStoryDraft {
  projectId: string;
  parentId?: string;
  openedAt: string;
  title?: string;
  description?: string;
}

/** POST /api/chats/:id/story-draft: which Project (and optionally which Epic in it) the Story goes in. */
export interface OpenStoryDraftRequest {
  projectId: string;
  parentId?: string;
}

/** POST /api/chats/:id/story: the person's edited draft. */
export interface MakeStoryRequest extends OpenStoryDraftRequest {
  title: string;
  description: string;
}

/** The Thread entries that link a chat and a Story made from it (runtime only; `story.md` carries no chat reference). */
export const ITEM_FROM_CHAT = 'item.from_chat';
export const CHAT_STORY_MADE = 'chat.story_made';
