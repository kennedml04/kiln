// The Scratch chat (see .scratch/scratch-chat/spec.md): a Session that belongs to no Project and
// no Item. Its Sessions run under a read-only Stage Policy like the Project Thread's, plus network
// access, and read every registered Project's checkout through the Session's `readRoots`.
import type { PolicyLayer } from './policy.ts';
import { PROJECT_THREAD_POLICY } from './project-thread.ts';

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

const PREFIX = 'chat:';

/** The id a Scratch chat's Sessions, Thread entries and Asks carry as their `itemId`. */
export const chatThreadId = (id: string) => `${PREFIX}${id}`;

/** The chat a subject id belongs to, or undefined for any other id. */
export const chatOfThread = (threadId: string): string | undefined =>
  threadId.startsWith(PREFIX) && !threadId.includes('/') && threadId.length > PREFIX.length ? threadId.slice(PREFIX.length) : undefined;

/** A Scratch chat as the API shows it. */
export interface ScratchChat {
  id: string;
  title: string;
  ownerId: string;
  createdAt: string;
  lastMessageAt: string;
  pinned: boolean;
  archivedAt?: string;
  /** The Item ids of Stories made from this chat. */
  stories: string[];
  running: boolean;
}
